package render

import (
	"github.com/srz-zumix/gali/internal/gcalendar"
	"google.golang.org/api/calendar/v3"
)

func (r *Renderer) decorate(event *calendar.Event, text string) string {
	if gcalendar.GetSelfResponseStatus(event) == "declined" {
		return "\x1b[9m" + text + "\x1b[0m"
	}
	return text
}
