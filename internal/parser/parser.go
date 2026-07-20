package parser

import (
	"fmt"
	"os"
	"strings"
	"time"
)

// getTimeZone returns the timezone from TZ env or Asia/Tokyo as default
func getTimeZone() string {
	tz := os.Getenv("TZ")
	if tz == "" {
		tz = "Asia/Tokyo"
	}
	return tz
}

// ParseDate parses date string (RFC3339 or YYYY-MM-DD) with timezone
func ParseDate(s string) (time.Time, error) {
	tz, err := time.LoadLocation(getTimeZone())
	if err != nil {
		tz = time.FixedZone("Asia/Tokyo", 9*60*60)
	}
	return time.ParseInLocation("2006-01-02", s, tz)
}

func ParseSinceUntil(since, until string) (string, string, error) {
	today := time.Now().Format("2006-01-02")
	if since == "" && until == "" {
		since = today
		until = today
	}

	if since != "" {
		sinceTime, err := ParseDate(since)
		if err != nil {
			return "", "", err
		}
		since = sinceTime.Format(time.RFC3339)
	}
	if until != "" {
		u, err := ParseDate(until)
		if err != nil {
			return "", "", err
		}
		untilTime := u.Add(23*time.Hour + 59*time.Minute)
		until = untilTime.Format(time.RFC3339)
	}
	return since, until, nil
}

// ParseWorkHours parses a "HH:MM-HH:MM" string into start/end offsets from midnight.
func ParseWorkHours(s string) (time.Duration, time.Duration, error) {
	parts := strings.Split(s, "-")
	if len(parts) != 2 {
		return 0, 0, fmt.Errorf("invalid work-hours format (expected HH:MM-HH:MM): %s", s)
	}
	start, err := parseClock(parts[0])
	if err != nil {
		return 0, 0, err
	}
	end, err := parseClock(parts[1])
	if err != nil {
		return 0, 0, err
	}
	if end <= start {
		return 0, 0, fmt.Errorf("work-hours end must be after start: %s", s)
	}
	return start, end, nil
}

func parseClock(s string) (time.Duration, error) {
	t, err := time.Parse("15:04", s)
	if err != nil {
		return 0, fmt.Errorf("invalid time format (expected HH:MM): %s", s)
	}
	return time.Duration(t.Hour())*time.Hour + time.Duration(t.Minute())*time.Minute, nil
}
