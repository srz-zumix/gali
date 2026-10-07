package cmd

import (
	"github.com/spf13/cobra"
	"github.com/srz-zumix/gali/version"
	"github.com/srz-zumix/go-gh-extension/pkg/copilotext"
)

func NewCopilotCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "copilot",
		Short: "Manage GitHub Copilot integrations",
	}
	cmd.AddCommand(copilotext.NewExtensionCmd(copilotext.Config{
		ToolName:    "gali",
		ToolVersion: version.Version,
		Extensions: []copilotext.Extension{
			{
				Name: "gali-calendar",
				URL:  "https://github.com/srz-zumix/gali/tree/main/.github/extensions/gali",
			},
		},
	}))
	return cmd
}
