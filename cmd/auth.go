package cmd

import (
	"context"
	"fmt"
	"strings"

	"github.com/spf13/cobra"
	"github.com/srz-zumix/gali/internal/gauth"
	"github.com/srz-zumix/gali/internal/gcalendar"
)

func NewAuthCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "auth",
		Short: "Sign in to Google and check the sign-in status",
	}
	cmd.AddCommand(newAuthLoginCmd())
	cmd.AddCommand(newAuthStatusCmd())
	return cmd
}

func newAuthLoginCmd() *cobra.Command {
	var quotaProject string
	var groups bool
	cmd := &cobra.Command{
		Use:   "login",
		Short: "Sign in to Google in the browser (runs gcloud for you)",
		Long: `Sign in to Google in the browser.

Runs "gcloud auth application-default login" with the scopes gali needs, so
the Google Cloud CLI must be installed. The quota project of the previous
login and the --groups choice are kept unless they are specified again.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			usesOAuthClient, err := gcalendar.UsesOAuthClient()
			if err != nil {
				return err
			}
			if usesOAuthClient {
				return fmt.Errorf("gali is configured to use OAuth client credentials (credentials.json or GALI_OAUTH_CREDENTIALS_JSON), so `gali auth login` has no effect; remove that configuration to use gcloud sign-in")
			}
			opts := gauth.LoginOptions{
				QuotaProject: quotaProject,
				Stdin:        cmd.InOrStdin(),
				Stdout:       cmd.OutOrStdout(),
				Stderr:       cmd.ErrOrStderr(),
			}
			if cmd.Flags().Changed("groups") {
				opts.Groups = &groups
			}
			if err := gauth.Login(opts); err != nil {
				return err
			}
			return printAuthStatus(cmd)
		},
	}
	cmd.Flags().StringVar(&quotaProject, "quota-project", "", "Google Cloud project used for API quota (default: keep the current one)")
	cmd.Flags().BoolVar(&groups, "groups", false, "Also allow reading Google Workspace groups (needed by check-visibility --group)")
	return cmd
}

func newAuthStatusCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "status",
		Short: "Show which Google account gali uses",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			return printAuthStatus(cmd)
		},
	}
}

func printAuthStatus(cmd *cobra.Command) error {
	status, err := gcalendar.CheckAuth(context.Background())
	if err != nil {
		if hint := quotaProjectHint(err); hint != "" {
			return fmt.Errorf("%w\n%s", err, hint)
		}
		return err
	}
	out := cmd.OutOrStdout()
	fmt.Fprintf(out, "Logged in as %s\n", status.Account)
	if status.Mode == gcalendar.AuthModeADC {
		if project, err := gauth.QuotaProject(); err == nil && project != "" {
			fmt.Fprintf(out, "Quota project: %s\n", project)
		}
	}
	return nil
}

func quotaProjectHint(err error) string {
	text := strings.ToLower(err.Error())
	if strings.Contains(text, "quota project") || strings.Contains(text, "service_disabled") || strings.Contains(text, "has not been used in project") {
		return "Run `gali auth login --quota-project <project-id>` with a Google Cloud project where the Google Calendar API is enabled"
	}
	return ""
}
