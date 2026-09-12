package gcalendar

import (
	"sort"
	"time"

	"google.golang.org/api/calendar/v3"
)

// SlotStatus represents the availability status of a candidate slot.
type SlotStatus string

const (
	SlotFree       SlotStatus = "FREE"
	SlotAdjustable SlotStatus = "ADJUSTABLE"
)

// SlotConflict describes an adjustable event that occupies a candidate slot.
type SlotConflict struct {
	CalendarID string
	Event      *calendar.Event
}

// SlotCandidate represents a single candidate time slot found by ComputeCandidates.
type SlotCandidate struct {
	Start     time.Time
	End       time.Time
	Status    SlotStatus
	Conflicts []SlotConflict
}

// SlotOptions configures the candidate slot search performed by ComputeCandidates.
type SlotOptions struct {
	Since           time.Time
	Until           time.Time
	Duration        time.Duration
	Step            time.Duration
	WorkStart       time.Duration // offset from midnight, e.g. 9h
	WorkEnd         time.Duration // offset from midnight, e.g. 18h
	IncludeWeekends bool
	Location        *time.Location
	MaxCandidates   int
}

// IsIgnorableEvent reports whether an event should be ignored entirely when
// determining slot availability (i.e. it never blocks a slot).
func IsIgnorableEvent(event *calendar.Event) bool {
	if GetSelfResponseStatus(event) == "declined" {
		return true
	}
	if event.Transparency == "transparent" {
		return true
	}
	return false
}

// IsAdjustableEvent reports whether an event is considered reschedulable and
// therefore should mark a slot as ADJUSTABLE instead of blocking it entirely.
func IsAdjustableEvent(event *calendar.Event) bool {
	// Private events without details (e.g. free/busy-only access) cannot be
	// judged, so treat them as fixed.
	if event.Visibility == "private" && event.Summary == "" {
		return false
	}
	switch GetSelfResponseStatus(event) {
	case "tentative", "needsAction":
		return true
	}
	if len(event.Attendees) == 0 {
		return true
	}
	if len(event.Attendees) == 1 && event.Attendees[0].Self {
		return true
	}
	if event.RecurringEventId != "" {
		return true
	}
	if event.Organizer != nil && event.Organizer.Self {
		return true
	}
	return false
}

// eventTimeRange resolves the start/end time of an event in the given location.
// ok is false if the event has no usable start/end information.
func eventTimeRange(loc *time.Location, e *calendar.Event) (start, end time.Time, ok bool) {
	if e.Start == nil || e.End == nil {
		return
	}
	if e.Start.DateTime != "" && e.End.DateTime != "" {
		s, err := time.Parse(time.RFC3339, e.Start.DateTime)
		if err != nil {
			return
		}
		en, err := time.Parse(time.RFC3339, e.End.DateTime)
		if err != nil {
			return
		}
		return s.In(loc), en.In(loc), true
	}
	if e.Start.Date != "" && e.End.Date != "" {
		s, err := time.ParseInLocation("2006-01-02", e.Start.Date, loc)
		if err != nil {
			return
		}
		en, err := time.ParseInLocation("2006-01-02", e.End.Date, loc)
		if err != nil {
			return
		}
		return s, en, true
	}
	return
}

func overlaps(aStart, aEnd, bStart, bEnd time.Time) bool {
	return aStart.Before(bEnd) && aEnd.After(bStart)
}

// ComputeCandidates scans the given time range in Step increments and returns
// candidate slots of length Duration that are either fully FREE or ADJUSTABLE
// (blocked only by reschedulable events) across all provided calendars.
func ComputeCandidates(calendarIDs []string, eventsByCalendar [][]*calendar.Event, opts SlotOptions) []SlotCandidate {
	var candidates []SlotCandidate

	for slotStart := opts.Since; !slotStart.Add(opts.Duration).After(opts.Until); slotStart = slotStart.Add(opts.Step) {
		slotEnd := slotStart.Add(opts.Duration)

		if !opts.IncludeWeekends {
			wd := slotStart.Weekday()
			if wd == time.Saturday || wd == time.Sunday {
				continue
			}
		}

		dayStart := time.Date(slotStart.Year(), slotStart.Month(), slotStart.Day(), 0, 0, 0, 0, opts.Location)
		workStart := dayStart.Add(opts.WorkStart)
		workEnd := dayStart.Add(opts.WorkEnd)
		if slotStart.Before(workStart) || slotEnd.After(workEnd) {
			continue
		}

		status := SlotFree
		var conflicts []SlotConflict
		busy := false
		for idx, events := range eventsByCalendar {
			calID := calendarIDs[idx]
			for _, e := range events {
				es, ee, ok := eventTimeRange(opts.Location, e)
				if !ok || !overlaps(slotStart, slotEnd, es, ee) {
					continue
				}
				if IsIgnorableEvent(e) {
					continue
				}
				if IsAdjustableEvent(e) {
					status = SlotAdjustable
					conflicts = append(conflicts, SlotConflict{CalendarID: calID, Event: e})
				} else {
					busy = true
				}
			}
			if busy {
				break
			}
		}
		if busy {
			continue
		}

		candidates = append(candidates, SlotCandidate{
			Start:     slotStart,
			End:       slotEnd,
			Status:    status,
			Conflicts: conflicts,
		})
	}

	sort.SliceStable(candidates, func(i, j int) bool {
		if candidates[i].Status != candidates[j].Status {
			return candidates[i].Status == SlotFree
		}
		if len(candidates[i].Conflicts) != len(candidates[j].Conflicts) {
			return len(candidates[i].Conflicts) < len(candidates[j].Conflicts)
		}
		return candidates[i].Start.Before(candidates[j].Start)
	})

	if opts.MaxCandidates > 0 && len(candidates) > opts.MaxCandidates {
		candidates = candidates[:opts.MaxCandidates]
	}

	return candidates
}
