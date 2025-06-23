package cmd

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"
)

var rootCmd = &cobra.Command{
	Use:   "gali",
	Short: "Google Calendar CLI",
	Long:  `Google Calendar CLI using Google Calendar API`,
}

func Execute() {
	if err := rootCmd.Execute(); err != nil {
		fmt.Println(err)
		os.Exit(1)
	}
}

func init() {
	rootCmd.AddCommand(NewListCmd())
	rootCmd.AddCommand(NewIntersectCmd())
}
