package tui

import (
	"fmt"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/gdamore/tcell/v2"
	"github.com/rivo/tview"
	"github.com/srz-zumix/gali/internal/gcalendar"
	"google.golang.org/api/calendar/v3"
)

// FetchEventsFunc fetches events for a given since/until range (RFC3339 strings).
// Returns nil if fetching is not supported (e.g., no callback provided).
type FetchEventsFunc func(since, until string) (*calendar.Events, error)

type MonthViewOptions struct {
	Title        string
	Month        time.Time // any day within the month; interpreted in Location
	ShowDeclined bool
	CalendarIDs  []string        // calendar IDs for color coding (used in union mode)
	FetchEvents  FetchEventsFunc // optional: callback to fetch events for a different month
}

// Event colors for visual distinction
var eventColors = []tcell.Color{
	tcell.ColorDodgerBlue,
	tcell.ColorMediumSeaGreen,
	tcell.ColorCoral,
	tcell.ColorMediumPurple,
	tcell.ColorGoldenrod,
	tcell.ColorCadetBlue,
}

// colorToName returns the color name for tview dynamic colors
func colorToName(c tcell.Color) string {
	switch c {
	case tcell.ColorDodgerBlue:
		return "dodgerblue"
	case tcell.ColorMediumSeaGreen:
		return "mediumseagreen"
	case tcell.ColorCoral:
		return "coral"
	case tcell.ColorMediumPurple:
		return "mediumpurple"
	case tcell.ColorGoldenrod:
		return "goldenrod"
	case tcell.ColorCadetBlue:
		return "cadetblue"
	default:
		return "white"
	}
}

func RunMonthView(events *calendar.Events, opts MonthViewOptions) error {
	loc := opts.Month.Location()
	monthFirst := time.Date(opts.Month.Year(), opts.Month.Month(), 1, 0, 0, 0, 0, loc)

	eventsByDay := groupEventsByDay(events, loc, opts.ShowDeclined)

	// Build calendar ID color map for union mode
	calendarColorMap := make(map[string]int)
	for i, calID := range opts.CalendarIDs {
		calendarColorMap[calID] = i
	}

	// switchMonth fetches events for the given month without mutating shared
	// UI state. The caller must apply the returned data on the UI goroutine.
	var fetchMu sync.Mutex
	fetching := false
	switchMonth := func(newMonthFirst time.Time) (map[string][]*calendar.Event, bool) {
		if opts.FetchEvents == nil {
			return nil, false
		}
		since := newMonthFirst.Format(time.RFC3339)
		// timeMax is exclusive: use the next month's midnight (DST-safe).
		until := newMonthFirst.AddDate(0, 1, 0).Format(time.RFC3339)
		newEvents, err := opts.FetchEvents(since, until)
		if err != nil {
			return nil, false
		}
		return groupEventsByDay(newEvents, loc, opts.ShowDeclined), true
	}

	app := tview.NewApplication()

	title := opts.Title
	if title == "" {
		title = "gali"
	}
	header := tview.NewTextView().
		SetDynamicColors(true).
		SetTextAlign(tview.AlignLeft)

	// updateHeader rebuilds header text for current monthFirst
	updateHeader := func() {
		headerText := fmt.Sprintf("%s  %s", title, monthFirst.Format("2006-01"))
		if len(opts.CalendarIDs) > 0 {
			var legend []string
			for i, calID := range opts.CalendarIDs {
				letter := string(rune('A' + i))
				color := eventColors[i%len(eventColors)]
				colorName := colorToName(color)
				legend = append(legend, fmt.Sprintf("[%s]%s[-]:%s", colorName, letter, calID))
			}
			headerText += "  " + strings.Join(legend, " ")
		}
		header.SetText(headerText)
	}
	updateHeader()

	help := tview.NewTextView().
		SetDynamicColors(true).
		SetTextAlign(tview.AlignLeft)
	if opts.FetchEvents != nil {
		help.SetText("[::b]q[::-]/Esc: quit  [::b]Tab[::-]: focus switch  [::b]↑↓←→[::-]: move  [::b]<[::-]/[::b]>[::-]: prev/next month  [::b]f[::-]: fetch day  [::b]r[::-]: reload month")
	} else {
		help.SetText("[::b]q[::-]/Esc: quit  [::b]Tab[::-]: focus switch  [::b]↑↓←→[::-]: move")
	}

	// Mini calendar (month view)
	miniCal := tview.NewTable().
		SetBorders(false).
		SetSelectable(true, true).
		SetFixed(1, 0)
	miniCal.SetTitle("Calendar").SetBorder(true)

	// Time grid (Google Calendar style)
	timeGrid := tview.NewTable().
		SetBorders(false).
		SetSelectable(true, false)
	timeGrid.SetBorder(true)

	// Detail view
	detailView := tview.NewTextView().
		SetDynamicColors(true).
		SetScrollable(true).
		SetWrap(true)
	detailView.SetBorder(true).SetTitle("Event Details")

	// State
	cellDate := map[[2]int]time.Time{}
	var selectedDate time.Time
	var currentEvents []*calendar.Event
	var gridRowToEvent map[int]*calendar.Event

	renderMiniCalendar := func() {
		miniCal.Clear()
		weekdays := []string{"S", "M", "T", "W", "T", "F", "S"}
		for c, w := range weekdays {
			miniCal.SetCell(0, c, tview.NewTableCell(w).
				SetSelectable(false).
				SetAlign(tview.AlignCenter).
				SetTextColor(tcell.ColorGray))
		}

		for k := range cellDate {
			delete(cellDate, k)
		}

		startWeekday := int(monthFirst.Weekday())
		day := monthFirst
		row, col := 1, startWeekday
		currentMonthLast := monthFirst.AddDate(0, 1, 0).Add(-time.Nanosecond)
		for day.Before(currentMonthLast) || day.Equal(currentMonthLast) {
			dateKey := day.Format("2006-01-02")
			count := len(eventsByDay[dateKey])
			label := fmt.Sprintf("%2d", day.Day())

			cell := tview.NewTableCell(label).SetAlign(tview.AlignCenter)

			// Today highlight
			if day.Format("2006-01-02") == time.Now().In(loc).Format("2006-01-02") {
				cell.SetTextColor(tcell.ColorYellow).SetAttributes(tcell.AttrBold)
			}

			// Has events indicator
			if count > 0 {
				cell.SetBackgroundColor(tcell.ColorDarkSlateGray)
			}

			cellDate[[2]int{row, col}] = day
			miniCal.SetCell(row, col, cell)

			col++
			if col > 6 {
				col = 0
				row++
			}
			day = day.AddDate(0, 0, 1)
		}
	}

	initialGrid := true

	updateTimeGrid := func(date time.Time) {
		// Save current scroll position before clearing
		prevRow, prevCol := timeGrid.GetSelection()
		prevOffsetRow, prevOffsetCol := timeGrid.GetOffset()

		timeGrid.Clear()
		gridRowToEvent = make(map[int]*calendar.Event)

		dateStr := date.Format("2006-01-02 (Mon)")
		timeGrid.SetTitle(dateStr)

		key := date.Format("2006-01-02")
		items := eventsByDay[key]
		sort.Slice(items, func(i, j int) bool {
			return eventSortKey(items[i], loc) < eventSortKey(items[j], loc)
		})
		currentEvents = items

		// Separate all-day and timed events
		allDayEvents := []*calendar.Event{}
		timedEvents := []*calendar.Event{}
		for _, ev := range items {
			if ev.Start == nil || ev.Start.DateTime == "" {
				allDayEvents = append(allDayEvents, ev)
			} else {
				timedEvents = append(timedEvents, ev)
			}
		}

		// Build organizer color map (same organizer = same color)
		organizerColorMap := make(map[string]int)
		colorCounter := 0
		getOrganizerColor := func(ev *calendar.Event) int {
			// Union mode: use CalendarIDs from Attendees for color coding
			if len(calendarColorMap) > 0 && len(ev.Attendees) > 0 {
				// Return first matching calendar ID's color
				for _, att := range ev.Attendees {
					if idx, ok := calendarColorMap[att.Email]; ok {
						return idx % len(eventColors)
					}
				}
			}

			// Default mode: use organizer for color coding
			organizer := ""
			if ev.Organizer != nil && ev.Organizer.Email != "" {
				organizer = ev.Organizer.Email
			} else if ev.Creator != nil && ev.Creator.Email != "" {
				organizer = ev.Creator.Email
			}
			if organizer == "" {
				organizer = ev.Id // fallback to event ID
			}
			if idx, ok := organizerColorMap[organizer]; ok {
				return idx
			}
			idx := colorCounter % len(eventColors)
			organizerColorMap[organizer] = idx
			colorCounter++
			return idx
		}

		// Get calendar markers for union mode (e.g., "[A][B]" for multiple calendars)
		getCalendarMarkers := func(ev *calendar.Event) string {
			if len(calendarColorMap) == 0 || len(ev.Attendees) == 0 {
				return ""
			}
			var markers []string
			for _, att := range ev.Attendees {
				if idx, ok := calendarColorMap[att.Email]; ok {
					// Use letters A, B, C, etc. for calendar markers
					letter := string(rune('A' + idx))
					color := eventColors[idx%len(eventColors)]
					markers = append(markers, fmt.Sprintf("[%s]%s[-]", colorToName(color), letter))
				}
			}
			if len(markers) > 0 {
				return strings.Join(markers, "") + " "
			}
			return ""
		}

		// Build time slot occupation map (30-minute slots)
		type eventSlot struct {
			event    *calendar.Event
			colorIdx int
		}
		slots := make(map[int][]eventSlot) // slot index -> events in that slot

		for _, ev := range timedEvents {
			startSlot, endSlot := getEventSlots(ev, loc, date)
			colorIdx := getOrganizerColor(ev)
			for slot := startSlot; slot < endSlot; slot++ {
				slots[slot] = append(slots[slot], eventSlot{ev, colorIdx})
			}
		}

		row := 0

		// Header
		timeGrid.SetCell(row, 0, tview.NewTableCell("Time").
			SetSelectable(false).
			SetTextColor(tcell.ColorGray).
			SetAlign(tview.AlignCenter))
		timeGrid.SetCell(row, 1, tview.NewTableCell("Events").
			SetSelectable(false).
			SetTextColor(tcell.ColorGray).
			SetAlign(tview.AlignLeft))
		row++

		// All-day events section (always show to keep position consistent)
		timeGrid.SetCell(row, 0, tview.NewTableCell("All-day").
			SetTextColor(tcell.ColorYellow).
			SetAlign(tview.AlignRight))
		if len(allDayEvents) > 0 {
			for i, ev := range allDayEvents {
				summary := ev.Summary
				if summary == "" {
					summary = "(Private Event)"
				}
				colorIdx := getOrganizerColor(ev)
				markers := getCalendarMarkers(ev)
				cell := tview.NewTableCell(" ■ " + markers + tview.Escape(summary)).
					SetTextColor(eventColors[colorIdx])
				if i == 0 {
					timeGrid.SetCell(row, 1, cell)
				} else {
					row++
					timeGrid.SetCell(row, 0, tview.NewTableCell(""))
					timeGrid.SetCell(row, 1, cell)
				}
				gridRowToEvent[row] = ev
			}
		} else {
			timeGrid.SetCell(row, 1, tview.NewTableCell("-").SetTextColor(tcell.ColorDarkGray))
		}
		row++
		// Separator
		timeGrid.SetCell(row, 0, tview.NewTableCell("─────").SetTextColor(tcell.ColorGray).SetSelectable(false))
		timeGrid.SetCell(row, 1, tview.NewTableCell("──────────────────────────").SetTextColor(tcell.ColorGray).SetSelectable(false))
		row++

		// Fix header, all-day section, and separator rows so they don't scroll
		timeGrid.SetFixed(row, 0)
		fixedRows := row

		// Time grid (30-minute intervals)
		for hour := 0; hour < 24; hour++ {
			for half := 0; half < 2; half++ {
				slotIdx := hour*2 + half
				timeLabel := ""
				if half == 0 {
					timeLabel = fmt.Sprintf("%02d:00", hour)
				} else {
					timeLabel = "     "
				}

				timeCell := tview.NewTableCell(timeLabel).
					SetAlign(tview.AlignRight)
				if half == 0 {
					timeCell.SetTextColor(tcell.ColorWhite)
				} else {
					timeCell.SetTextColor(tcell.ColorGray)
				}

				eventCell := tview.NewTableCell("")
				slotEvents := slots[slotIdx]

				if len(slotEvents) == 0 {
					// Empty slot - show subtle line
					eventCell.SetText("│").SetTextColor(tcell.ColorDarkGray)
				} else {
					// Show events in this slot
					var parts []string
					for _, se := range slotEvents {
						startSlot, _ := getEventSlots(se.event, loc, date)
						if startSlot == slotIdx {
							// Event starts here (or continues from a previous day) - show full info
							summary := se.event.Summary
							if summary == "" {
								summary = "(Private)"
							}
							endTime := ""
							if se.event.End != nil && se.event.End.DateTime != "" {
								if e, err := time.Parse(time.RFC3339, se.event.End.DateTime); err == nil {
									eLoc := e.In(loc)
									dayEnd := time.Date(date.Year(), date.Month(), date.Day(), 0, 0, 0, 0, loc).AddDate(0, 0, 1)
									if !eLoc.Before(dayEnd) {
										// Event continues past this day.
										endTime = "24:00"
									} else {
										endTime = eLoc.Format("15:04")
									}
								}
							}
							markers := getCalendarMarkers(se.event)
							text := fmt.Sprintf("┌─%s %s%s", endTime, markers, tview.Escape(summary))
							parts = append(parts, text)
						} else {
							// Event continues
							parts = append(parts, "│")
						}
					}

					if len(parts) > 0 {
						eventCell.SetText(strings.Join(parts, " ")).
							SetTextColor(eventColors[slotEvents[0].colorIdx])
					}

					// Map first event in slot to this row
					gridRowToEvent[row] = slotEvents[0].event
				}

				timeGrid.SetCell(row, 0, timeCell)
				timeGrid.SetCell(row, 1, eventCell)
				row++
			}
		}

		// Show first event details
		if len(currentEvents) > 0 {
			detailView.SetText(formatEventDetail(currentEvents[0], loc))
			detailView.ScrollToBeginning()
		} else {
			detailView.SetText("")
		}

		// Restore or initialize scroll position
		if initialGrid {
			// First time: scroll to 8:00 AM
			timeGrid.Select(fixedRows+8*2, 0)
			timeGrid.SetOffset(8*2, 0)
			initialGrid = false
		} else {
			// Subsequent: maintain previous scroll position
			timeGrid.SetOffset(prevOffsetRow, prevOffsetCol)
			timeGrid.Select(prevRow, prevCol)
		}
	}

	renderMiniCalendar()

	// selectFirstDay selects the first valid day cell in the mini calendar
	selectFirstDay := func() {
		for col := 0; col < 7; col++ {
			if d, ok := cellDate[[2]int{1, col}]; ok {
				miniCal.Select(1, col)
				updateTimeGrid(d)
				return
			}
		}
	}

	// navigateMonth fetches events for newMonth asynchronously and updates UI
	navigateMonth := func(newMonth time.Time) {
		if opts.FetchEvents == nil {
			return
		}
		fetchMu.Lock()
		if fetching {
			fetchMu.Unlock()
			return
		}
		fetching = true
		fetchMu.Unlock()

		// Show loading state immediately
		header.SetText(fmt.Sprintf("%s  %s  [yellow]Loading...[-]", title, newMonth.Format("2006-01")))

		go func() {
			newEventsByDay, ok := switchMonth(newMonth)
			app.QueueUpdateDraw(func() {
				fetchMu.Lock()
				fetching = false
				fetchMu.Unlock()
				if ok {
					monthFirst = newMonth
					eventsByDay = newEventsByDay
					updateHeader()
					renderMiniCalendar()
					selectFirstDay()
				} else {
					updateHeader() // restore original header
				}
			})
		}()
	}

	// Initial selection: use opts.Month (which may be since date)
	initial := opts.Month
	if initial.Month() != monthFirst.Month() || initial.Year() != monthFirst.Year() {
		initial = monthFirst
	}

	var initRow, initCol int
	found := false
	for rc, d := range cellDate {
		if d.Year() == initial.Year() && d.Month() == initial.Month() && d.Day() == initial.Day() {
			initRow, initCol = rc[0], rc[1]
			found = true
			break
		}
	}
	if found {
		selectedDate = initial
		miniCal.Select(initRow, initCol)
		updateTimeGrid(initial)
	}

	miniCal.SetSelectionChangedFunc(func(row, column int) {
		if d, ok := cellDate[[2]int{row, column}]; ok {
			selectedDate = d
			updateTimeGrid(d)
		}
	})

	timeGrid.SetSelectionChangedFunc(func(row, column int) {
		if ev, ok := gridRowToEvent[row]; ok {
			detailView.SetText(formatEventDetail(ev, loc))
			detailView.ScrollToBeginning()
		}
	})

	// Layout: Left (mini calendar + details) | Right (time grid)
	leftPane := tview.NewFlex().SetDirection(tview.FlexRow)
	leftPane.AddItem(miniCal, 9, 0, true)
	leftPane.AddItem(detailView, 0, 1, false)

	main := tview.NewFlex().SetDirection(tview.FlexColumn)
	main.AddItem(leftPane, 50, 0, true)
	main.AddItem(timeGrid, 0, 1, false)

	root := tview.NewFlex().SetDirection(tview.FlexRow)
	root.AddItem(header, 1, 0, false)
	root.AddItem(main, 0, 1, true)
	root.AddItem(help, 1, 0, false)

	focusIdx := 0
	focusTargets := []tview.Primitive{miniCal, timeGrid, detailView}
	app.SetInputCapture(func(event *tcell.EventKey) *tcell.EventKey {
		switch event.Key() {
		case tcell.KeyEsc:
			app.Stop()
			return nil
		case tcell.KeyTAB:
			// Tab: next element
			focusIdx = (focusIdx + 1) % len(focusTargets)
			app.SetFocus(focusTargets[focusIdx])
			return nil
		case tcell.KeyBacktab:
			// Shift+Tab (BackTab): previous element
			focusIdx = (focusIdx - 1 + len(focusTargets)) % len(focusTargets)
			app.SetFocus(focusTargets[focusIdx])
			return nil
		}
		switch event.Rune() {
		case 'q', 'Q':
			app.Stop()
			return nil
		case '<', ',':
			// Previous month
			navigateMonth(monthFirst.AddDate(0, -1, 0))
			return nil
		case '>', '.':
			// Next month
			navigateMonth(monthFirst.AddDate(0, 1, 0))
			return nil
		case 'f':
			// Fetch events for the currently selected day
			if opts.FetchEvents == nil || selectedDate.IsZero() {
				break
			}
			fetchMu.Lock()
			if fetching {
				fetchMu.Unlock()
				break
			}
			fetching = true
			fetchMu.Unlock()

			day := selectedDate
			header.SetText(fmt.Sprintf("%s  %s  [yellow]Loading %s...[-]", title, monthFirst.Format("2006-01"), day.Format("01-02")))
			go func() {
				since := day.Format(time.RFC3339)
				// timeMax is exclusive: use the next day's midnight (DST-safe).
				until := day.AddDate(0, 0, 1).Format(time.RFC3339)
				newEvents, err := opts.FetchEvents(since, until)
				app.QueueUpdateDraw(func() {
					fetchMu.Lock()
					fetching = false
					fetchMu.Unlock()
					if err == nil {
						// Replace only the selected day's bucket. Multi-day events
						// may span other days, but a single-day fetch is not an
						// authoritative refresh of those days, so we must not
						// clobber their cached events.
						dayEvents := groupEventsByDay(newEvents, loc, opts.ShowDeclined)
						dayKey := day.Format("2006-01-02")
						eventsByDay[dayKey] = dayEvents[dayKey]
						updateHeader()
						renderMiniCalendar()
						// Re-select the same date
						for rc, d := range cellDate {
							if d.Equal(day) {
								miniCal.Select(rc[0], rc[1])
								updateTimeGrid(day)
								return
							}
						}
					} else {
						updateHeader()
					}
				})
			}()
			return nil
		case 'r':
			// Reload current month (fetch full month events)
			if opts.FetchEvents == nil {
				break
			}
			fetchMu.Lock()
			if fetching {
				fetchMu.Unlock()
				break
			}
			fetching = true
			fetchMu.Unlock()

			header.SetText(fmt.Sprintf("%s  %s  [yellow]Loading...[-]", title, monthFirst.Format("2006-01")))
			curSel := selectedDate
			go func() {
				since := monthFirst.Format(time.RFC3339)
				// timeMax is exclusive: use the next month's midnight (DST-safe).
				until := monthFirst.AddDate(0, 1, 0).Format(time.RFC3339)
				newEvents, err := opts.FetchEvents(since, until)
				app.QueueUpdateDraw(func() {
					fetchMu.Lock()
					fetching = false
					fetchMu.Unlock()
					if err == nil {
						eventsByDay = groupEventsByDay(newEvents, loc, opts.ShowDeclined)
						updateHeader()
						renderMiniCalendar()
						// Re-select the previously selected date
						if !curSel.IsZero() {
							for rc, d := range cellDate {
								if d.Equal(curSel) {
									miniCal.Select(rc[0], rc[1])
									updateTimeGrid(curSel)
									return
								}
							}
						}
						selectFirstDay()
					} else {
						updateHeader()
					}
				})
			}()
			return nil
		}
		return event
	})

	if _, ok := os.LookupEnv("TERM"); !ok {
		return fmt.Errorf("TERM is not set")
	}

	return app.SetRoot(root, true).Run()
}

func groupEventsByDay(events *calendar.Events, loc *time.Location, showDeclined bool) map[string][]*calendar.Event {
	out := map[string][]*calendar.Event{}
	if events == nil {
		return out
	}
	for _, ev := range events.Items {
		if !showDeclined {
			if gcalendar.GetSelfResponseStatus(ev) == "declined" {
				continue
			}
		}
		for _, key := range eventDayKeys(ev, loc) {
			out[key] = append(out[key], ev)
		}
	}
	return out
}

// eventDayKeys returns the "2006-01-02" keys for every day the event occupies.
// Timed events use a half-open [start, end) interval; all-day events use the
// Google Calendar half-open [Start.Date, End.Date) convention.
func eventDayKeys(ev *calendar.Event, loc *time.Location) []string {
	if ev == nil || ev.Start == nil {
		return nil
	}

	var startDay, lastDay time.Time

	switch {
	case ev.Start.DateTime != "":
		s, err := time.Parse(time.RFC3339, ev.Start.DateTime)
		if err != nil {
			return nil
		}
		sLoc := s.In(loc)
		startDay = time.Date(sLoc.Year(), sLoc.Month(), sLoc.Day(), 0, 0, 0, 0, loc)
		lastDay = startDay
		if ev.End != nil && ev.End.DateTime != "" {
			if e, err := time.Parse(time.RFC3339, ev.End.DateTime); err == nil {
				eLoc := e.In(loc)
				// Half-open interval: the last occupied day is the day of end-1ns.
				last := eLoc.Add(-time.Nanosecond)
				if last.After(sLoc) {
					lastDay = time.Date(last.Year(), last.Month(), last.Day(), 0, 0, 0, 0, loc)
				}
			}
		}
	case ev.Start.Date != "":
		s, err := time.ParseInLocation("2006-01-02", ev.Start.Date, loc)
		if err != nil {
			return nil
		}
		startDay = s
		lastDay = s
		if ev.End != nil && ev.End.Date != "" {
			if e, err := time.ParseInLocation("2006-01-02", ev.End.Date, loc); err == nil {
				// End.Date is exclusive: last occupied day is End.Date - 1.
				last := e.AddDate(0, 0, -1)
				if last.After(s) {
					lastDay = last
				}
			}
		}
	default:
		return nil
	}

	var keys []string
	for d := startDay; !d.After(lastDay); d = d.AddDate(0, 0, 1) {
		keys = append(keys, d.Format("2006-01-02"))
	}
	return keys
}

// getEventSlots returns start and end slot indices (30-minute intervals, 0-48)
// for the event as it should be rendered on the given day. Events that begin on
// an earlier day are clamped to start at slot 0, and events that continue past
// the given day are clamped to end at slot 48.
func getEventSlots(ev *calendar.Event, loc *time.Location, day time.Time) (int, int) {
	if ev == nil || ev.Start == nil || ev.Start.DateTime == "" {
		return 0, 0
	}

	dayStart := time.Date(day.Year(), day.Month(), day.Day(), 0, 0, 0, 0, loc)
	dayEnd := dayStart.AddDate(0, 0, 1) // DST-safe next midnight

	start, err := time.Parse(time.RFC3339, ev.Start.DateTime)
	if err != nil {
		return 0, 1
	}
	start = start.In(loc)

	end := start.Add(30 * time.Minute) // minimal default duration
	if ev.End != nil && ev.End.DateTime != "" {
		if e, err := time.Parse(time.RFC3339, ev.End.DateTime); err == nil {
			eLoc := e.In(loc)
			if eLoc.After(start) {
				end = eLoc
			}
		}
	}

	startSlot := 0
	if !start.Before(dayStart) {
		startSlot = start.Hour()*2 + start.Minute()/30
	}

	endSlot := 48
	if end.Before(dayEnd) {
		endSlot = end.Hour()*2 + end.Minute()/30
		if end.Minute()%30 > 0 {
			endSlot++ // Round up
		}
	}

	if endSlot <= startSlot {
		endSlot = startSlot + 1
	}
	if endSlot > 48 {
		endSlot = 48
	}

	return startSlot, endSlot
}

func eventSortKey(ev *calendar.Event, loc *time.Location) string {
	if ev == nil || ev.Start == nil {
		return ""
	}
	if ev.Start.DateTime != "" {
		if t, err := time.Parse(time.RFC3339, ev.Start.DateTime); err == nil {
			return t.In(loc).Format(time.RFC3339Nano)
		}
		return ev.Start.DateTime
	}
	return ev.Start.Date
}

func formatEventDetail(ev *calendar.Event, loc *time.Location) string {
	if ev == nil {
		return "No event information"
	}
	var sb strings.Builder

	summary := ev.Summary
	if summary == "" {
		summary = "(Private Event)"
	}
	fmt.Fprintf(&sb, "[yellow::b]%s[::-]\n\n", tview.Escape(summary))

	// Time
	if ev.Start != nil {
		if ev.Start.DateTime != "" {
			start := ev.Start.DateTime
			end := ""
			if ev.End != nil && ev.End.DateTime != "" {
				end = ev.End.DateTime
			}
			if t, err := time.Parse(time.RFC3339, start); err == nil {
				fmt.Fprintf(&sb, "[white::b]When:[::-] %s", t.In(loc).Format("2006-01-02 15:04"))
				if end != "" {
					if te, err := time.Parse(time.RFC3339, end); err == nil {
						fmt.Fprintf(&sb, " - %s", te.In(loc).Format("15:04"))
					}
				}
				sb.WriteString("\n")
			}
		} else if ev.Start.Date != "" {
			fmt.Fprintf(&sb, "[white::b]When:[::-] %s (All-day)\n", ev.Start.Date)
		}
	}

	// Location
	if ev.Location != "" {
		fmt.Fprintf(&sb, "[white::b]Location:[::-] %s\n", tview.Escape(ev.Location))
	}

	// Status
	status := gcalendar.GetSelfResponseStatus(ev)
	if status != "" {
		fmt.Fprintf(&sb, "[white::b]Status:[::-] %s\n", status)
	}

	// Attendees
	if len(ev.Attendees) > 0 {
		fmt.Fprintf(&sb, "\n[white::b]Attendees (%d):[::-]\n", len(ev.Attendees))
		for i, att := range ev.Attendees {
			if i >= 20 {
				fmt.Fprintf(&sb, "  ... and %d more\n", len(ev.Attendees)-20)
				break
			}
			name := att.Email
			if att.DisplayName != "" {
				name = att.DisplayName
			}
			name = tview.Escape(name)
			self := ""
			if att.Self {
				self = " [green](you)[-]"
			}
			// Color and style by response status
			switch att.ResponseStatus {
			case "accepted":
				fmt.Fprintf(&sb, "  [green]✔ %s[-]%s\n", name, self)
			case "declined":
				fmt.Fprintf(&sb, "  [red::d]✘ [::s]%s[::-][-]%s\n", name, self)
			case "tentative":
				fmt.Fprintf(&sb, "  [yellow]? %s[-]%s\n", name, self)
			case "needsAction":
				fmt.Fprintf(&sb, "  [gray]… %s[-]%s\n", name, self)
			default:
				fmt.Fprintf(&sb, "  • %s%s\n", name, self)
			}
		}
	}

	// Description
	if ev.Description != "" {
		sb.WriteString("\n[white::b]Description:[::-]\n")
		sb.WriteString(tview.Escape(ev.Description))
		sb.WriteString("\n")
	}

	// Link
	if ev.HtmlLink != "" {
		fmt.Fprintf(&sb, "\n[white::b]Link:[::-] %s\n", ev.HtmlLink)
	}

	return sb.String()
}
