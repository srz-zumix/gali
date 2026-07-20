package cmd

import "github.com/spf13/cobra"

var (
	calendarID      string
	since           string
	until           string
	format          string
	showDeclined    bool
	refIDs          []string
	building        string
	refMyCals       bool
	debug           bool
	duration        string
	step            string
	workHours       string
	includeWeekends bool
	maxCandidates   int
)

func AddDebugFlag(cmd *cobra.Command) {
	f := cmd.Flags()
	f.BoolVar(&debug, "debug", false, "Enable debug mode")
	err := f.MarkHidden("debug")
	if err != nil {
		panic(err)
	}
}
