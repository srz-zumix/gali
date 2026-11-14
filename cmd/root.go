package cmd

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"
	"github.com/srz-zumix/gali/version"
)

var rootCmd = &cobra.Command{
	Use:     "gali",
	Short:   "Google Calendar CLI",
	Long:    `Google Calendar CLI using Google Calendar API`,
	Version: version.Version,
}

func Execute() {
	command, err := rootCmd.ExecuteC()
	if err != nil {
		if command != nil && command.Name() == "check-visibility" {
			fmt.Fprintln(os.Stderr, err)
		} else {
			fmt.Println(err)
		}
		os.Exit(1)
	}
}

func init() {
	rootCmd.AddCommand(NewCalendarCmd())
	rootCmd.AddCommand(NewCheckVisibilityCmd())
	rootCmd.AddCommand(NewCopilotCmd())
	rootCmd.AddCommand(NewEventsCmd())
	rootCmd.AddCommand(NewIntersectCmd())
	rootCmd.AddCommand(NewListCmd())
	rootCmd.AddCommand(NewResCmd())
	rootCmd.AddCommand(NewSuggestCmd())
	rootCmd.AddCommand(NewUnionCmd())
}
