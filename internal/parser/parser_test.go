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
