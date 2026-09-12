package parser

import (
	"testing"
	"time"
)

func TestParseWorkHours(t *testing.T) {
	cases := []struct {
		in        string
		wantStart time.Duration
		wantEnd   time.Duration
		wantErr   bool
	}{
		{"10:00-18:00", 10 * time.Hour, 18 * time.Hour, false},
		{"10:00 - 18:00", 10 * time.Hour, 18 * time.Hour, false},
		{" 09:30 -\t17:45 ", 9*time.Hour + 30*time.Minute, 17*time.Hour + 45*time.Minute, false},
		{"18:00-10:00", 0, 0, true},
		{"10:00", 0, 0, true},
		{"aa:bb-cc:dd", 0, 0, true},
	}
	for _, c := range cases {
		start, end, err := ParseWorkHours(c.in)
		if c.wantErr {
			if err == nil {
				t.Errorf("ParseWorkHours(%q): expected error, got none", c.in)
			}
			continue
		}
		if err != nil {
			t.Errorf("ParseWorkHours(%q): unexpected error: %v", c.in, err)
			continue
		}
		if start != c.wantStart || end != c.wantEnd {
			t.Errorf("ParseWorkHours(%q) = (%v, %v), want (%v, %v)", c.in, start, end, c.wantStart, c.wantEnd)
		}
	}
}

func TestParseSinceUntilExclusiveNextMidnight(t *testing.T) {
	t.Setenv("TZ", "Asia/Tokyo")
	since, until, err := ParseSinceUntil("2026-01-05", "2026-01-05")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if since != "2026-01-05T00:00:00+09:00" {
		t.Errorf("since = %q, want 2026-01-05T00:00:00+09:00", since)
	}
	// timeMax is exclusive: the day after `until` at midnight.
	if until != "2026-01-06T00:00:00+09:00" {
		t.Errorf("until = %q, want 2026-01-06T00:00:00+09:00", until)
	}
}

func TestParseSinceUntilDSTSafe(t *testing.T) {
	// US spring-forward day (2026-03-08) is only 23 hours long; a naive
	// "+23h59m" offset would spill past local midnight. The exclusive
	// next-midnight boundary must stay at the following local midnight.
	t.Setenv("TZ", "America/New_York")
	_, until, err := ParseSinceUntil("2026-03-08", "2026-03-08")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if until != "2026-03-09T00:00:00-04:00" {
		t.Errorf("until = %q, want 2026-03-09T00:00:00-04:00", until)
	}
}
