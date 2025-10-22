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
	if err := rootCmd.Execute(); err != nil {
		fmt.Println(err)
		os.Exit(1)
	}
}

func init() {
	rootCmd.AddCommand(NewEventsCmd())
	rootCmd.AddCommand(NewIntersectCmd())
	rootCmd.AddCommand(NewListCmd())
	rootCmd.AddCommand(NewResCmd())
	rootCmd.AddCommand(NewUnionCmd())
}
