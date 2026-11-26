package gcalendar

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"

	"golang.org/x/oauth2/google"
	"google.golang.org/api/calendar/v3"
	"google.golang.org/api/googleapi"
	"google.golang.org/api/option"
)

// ErrLoginRequired marks failures that signing in again can fix.
var ErrLoginRequired = errors.New("login required")

const (
	AuthModeADC         = "adc"
	AuthModeOAuthClient = "oauth-client"
)

// AuthStatus describes the credentials gali would use.
type AuthStatus struct {
	Mode    string
	Account string
}

func loginHint(mode string) string {
	if mode == AuthModeOAuthClient {
		return fmt.Sprintf("delete ~/.credentials/%s and run `gali list` to authorize again", defaultTokenCacheFile)
	}
	return "run `gali auth login`"
}

// UsesOAuthClient reports whether gali is configured with OAuth client
// credentials, in which case gcloud Application Default Credentials are unused.
func UsesOAuthClient() (bool, error) {
	config, err := getGoogleConfig(GetGaliScope())
	if err != nil {
		return false, err
	}
	return config != nil, nil
}

// CheckAuth verifies the credentials without starting an interactive login.
func CheckAuth(ctx context.Context) (*AuthStatus, error) {
	scopes := GetGaliScope()
	config, err := getGoogleConfig(scopes)
	if err != nil {
		return nil, fmt.Errorf("unable to get Google API config: %w", err)
	}

	status := &AuthStatus{Mode: AuthModeADC}
	var opt option.ClientOption
	if config != nil {
		status.Mode = AuthModeOAuthClient
		path, err := tokenCachePath(defaultTokenCacheFile)
		if err != nil {
			return status, err
		}
		tok, err := tokenFromFile(path)
		if err != nil {
			if os.IsNotExist(err) {
				return status, fmt.Errorf("%w: OAuth client credentials are configured but not authorized yet; run `gali list` to authorize", ErrLoginRequired)
			}
			return status, fmt.Errorf("unable to read token cache %s: %w", path, err)
		}
		opt = option.WithHTTPClient(config.Client(ctx, tok))
	} else {
		creds, err := google.FindDefaultCredentials(ctx, scopes...)
		if err != nil {
			return status, fmt.Errorf("%w: %v; %s", ErrLoginRequired, err, loginHint(status.Mode))
		}
		if _, err := creds.TokenSource.Token(); err != nil {
			return status, fmt.Errorf("%w: %v; %s", ErrLoginRequired, err, loginHint(status.Mode))
		}
		opt = option.WithCredentials(creds)
	}

	srv, err := calendar.NewService(ctx, opt)
	if err != nil {
		return status, fmt.Errorf("unable to create Calendar service: %w", err)
	}
	entry, err := srv.CalendarList.Get("primary").Context(ctx).Do()
	if err != nil {
		if needsLogin(err) {
			return status, fmt.Errorf("%w: %v; %s", ErrLoginRequired, err, loginHint(status.Mode))
		}
		return status, fmt.Errorf("unable to read the primary calendar: %w", err)
	}
	status.Account = entry.Id
	return status, nil
}

func needsLogin(err error) bool {
	var apiErr *googleapi.Error
	if errors.As(err, &apiErr) {
		if apiErr.Code == http.StatusUnauthorized {
			return true
		}
		if apiErr.Code == http.StatusForbidden && strings.Contains(strings.ToLower(apiErr.Error()), "insufficient") {
			return true
		}
		return false
	}
	text := strings.ToLower(err.Error())
	return strings.Contains(text, "invalid_grant") || strings.Contains(text, "invalid_rapt") || strings.Contains(text, "cannot fetch token")
}
