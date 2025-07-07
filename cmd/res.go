package cmd

import (
	"github.com/spf13/cobra"
	rescmd "github.com/srz-zumix/gali/cmd/res"
)

func NewResCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "res",
		Short: "Resource calendar commands",
	}
	cmd.AddCommand(rescmd.NewResListCmd())
	return cmd
}
