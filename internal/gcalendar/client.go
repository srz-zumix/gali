package gcalendar

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/user"
	"path/filepath"

	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"
	admdir "google.golang.org/api/admin/directory/v1"
	"google.golang.org/api/calendar/v3"
	"google.golang.org/api/cloudidentity/v1"
	"google.golang.org/api/option"
	googlehttp "google.golang.org/api/transport/http"
)

const (
	defaultTokenCacheFile          = "gali_token.json"
	visibilityGroupsTokenCacheFile = "gali_visibility_groups_token.json"
)

func getClient(config *oauth2.Config) (*http.Client, error) {
	return getClientWithTokenFile(context.Background(), config, defaultTokenCacheFile, os.Stdout)
}

func getClientWithTokenFile(ctx context.Context, config *oauth2.Config, tokenFile string, output io.Writer) (*http.Client, error) {
	usr, err := user.Current()
	if err != nil {
		return nil, fmt.Errorf("unable to get current user: %w", err)
	}
	tokenCacheDir := filepath.Join(usr.HomeDir, ".credentials")
	tokenCacheFile := filepath.Join(tokenCacheDir, tokenFile)

	tok, err := tokenFromFile(tokenCacheFile)
	if err != nil {
		if !os.IsNotExist(err) {
			return nil, fmt.Errorf("unable to read token cache %s: %w", tokenCacheFile, err)
		}
		if err := os.MkdirAll(tokenCacheDir, 0700); err != nil {
			return nil, fmt.Errorf("unable to create token cache directory: %w", err)
		}
		tok, err = getTokenFromWeb(ctx, config, output)
		if err != nil {
			return nil, fmt.Errorf("unable to get token from web: %w", err)
		}
		if err := saveToken(tokenCacheFile, tok, output); err != nil {
			return nil, fmt.Errorf("unable to save token: %w", err)
		}
	}
	return config.Client(ctx, tok), nil
}

func getTokenFromWeb(ctx context.Context, config *oauth2.Config, output io.Writer) (*oauth2.Token, error) {
	ln, err := net.Listen("tcp", "localhost:0")
	if err != nil {
		return nil, fmt.Errorf("unable to start local server: %w", err)
	}
	defer func() {
		if closeErr := ln.Close(); closeErr != nil {
			log.Printf("Warning: failed to close listener: %v", closeErr)
		}
	}()
	redirectURL := fmt.Sprintf("http://%s", ln.Addr().String())
	config.RedirectURL = redirectURL

	url := config.AuthCodeURL("state-token", oauth2.AccessTypeOffline)
	if _, err := fmt.Fprintf(output, "Go to the following link in your browser:\n%v\n", url); err != nil {
		return nil, fmt.Errorf("unable to display authorization URL: %w", err)
	}

	codeCh := make(chan string, 1)
	errCh := make(chan error, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			errCh <- fmt.Errorf("unable to accept connection: %w", err)
			return
		}
		defer func() {
			if closeErr := conn.Close(); closeErr != nil {
				log.Printf("Warning: failed to close connection: %v", closeErr)
			}
		}()
		req, err := http.ReadRequest(bufio.NewReader(conn))
		if err != nil {
			errCh <- fmt.Errorf("unable to read request: %w", err)
			return
		}
		q := req.URL.Query()
		code := q.Get("code")
		_, err = fmt.Fprintf(conn, "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\nAuthentication complete. You may close this window.")
		if err != nil {
			errCh <- fmt.Errorf("unable to write response: %w", err)
			return
		}
		codeCh <- code
	}()

	select {
	case code := <-codeCh:
		if code == "" {
			return nil, fmt.Errorf("no code received from browser redirect")
		}
		tok, err := config.Exchange(ctx, code)
		if err != nil {
			return nil, fmt.Errorf("unable to retrieve token from web: %w", err)
		}
		return tok, nil
	case err := <-errCh:
		return nil, err
	case <-ctx.Done():
		return nil, fmt.Errorf("authorization canceled: %w", ctx.Err())
	}
}

func tokenFromFile(file string) (*oauth2.Token, error) {
	f, err := os.Open(file)
	if err != nil {
		return nil, err
	}
	defer func() {
		if closeErr := f.Close(); closeErr != nil {
			log.Printf("Warning: failed to close file: %v", closeErr)
		}
	}()
	tok := &oauth2.Token{}
	err = json.NewDecoder(f).Decode(tok)
	return tok, err
}

func saveToken(path string, token *oauth2.Token, output io.Writer) error {
	if _, err := fmt.Fprintf(output, "Saving credential file to: %s\n", path); err != nil {
		return fmt.Errorf("unable to display token file path: %w", err)
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0600)
	if err != nil {
		return fmt.Errorf("unable to create token file: %w", err)
	}
	defer func() {
		if closeErr := f.Close(); closeErr != nil {
			log.Printf("Warning: failed to close token file: %v", closeErr)
		}
	}()
	if err := json.NewEncoder(f).Encode(token); err != nil {
		return fmt.Errorf("unable to encode token to file: %w", err)
	}
	return nil
}

// getGoogleConfig attempts to load Google API configuration,
// first from credentials.json, and if not found, then from environment variables.
func getGoogleConfig(scopes []string) (*oauth2.Config, error) {
	// Try to read from credentials.json first
	credentialsFile := os.Getenv("GALI_OAUTH_CREDENTIALS_JSON")
	if credentialsFile == "" {
		credentialsFile = "credentials.json"
	}

	b, err := os.ReadFile(credentialsFile)
	if err == nil {
		config, parseErr := google.ConfigFromJSON(b, scopes...)
		if parseErr != nil {
			return nil, fmt.Errorf("unable to parse credentials.json: %w", parseErr)
		}
		return config, nil
	}

	// If credentials.json not found, try environment variables
	if os.IsNotExist(err) {
		// Neither credentials.json nor environment variables are set.
		return nil, nil // Signal to fallback to ADC
	}

	// Other error reading credentials.json
	return nil, fmt.Errorf("unable to read %v: %w", credentialsFile, err)
}

func GetGaliScope() []string {
	return []string{
		calendar.CalendarReadonlyScope,
		admdir.AdminDirectoryResourceCalendarReadonlyScope,
	}
}

func visibilityAuthProfile(includeGroups bool) ([]string, string) {
	if includeGroups {
		return []string{
			calendar.CalendarReadonlyScope,
			cloudidentity.CloudIdentityGroupsReadonlyScope,
		}, visibilityGroupsTokenCacheFile
	}
	return GetGaliScope(), defaultTokenCacheFile
}

// GetVisibilityServices uses one authenticated client for both APIs.
func GetVisibilityServices(ctx context.Context, includeGroups bool, output io.Writer) (*calendar.Service, *cloudidentity.Service, error) {
	scopes, tokenFile := visibilityAuthProfile(includeGroups)
	config, err := getGoogleConfig(scopes)
	if err != nil {
		return nil, nil, fmt.Errorf("unable to get Google API config: %w", err)
	}

	if output == nil {
		output = io.Discard
	}
	var client *http.Client
	if config != nil {
		client, err = getClientWithTokenFile(ctx, config, tokenFile, output)
	} else {
		client, _, err = googlehttp.NewClient(ctx, option.WithScopes(scopes...))
	}
	if err != nil {
		return nil, nil, fmt.Errorf("unable to create authenticated HTTP client: %w", err)
	}

	return newVisibilityServices(ctx, client, includeGroups)
}

func newVisibilityServices(ctx context.Context, client *http.Client, includeGroups bool) (*calendar.Service, *cloudidentity.Service, error) {
	if client == nil {
		return nil, nil, fmt.Errorf("authenticated HTTP client is unavailable")
	}
	calendarService, err := calendar.NewService(ctx, option.WithHTTPClient(client))
	if err != nil {
		return nil, nil, fmt.Errorf("unable to create Calendar service: %w", err)
	}
	if !includeGroups {
		return calendarService, nil, nil
	}
	groupsService, err := cloudidentity.NewService(ctx, option.WithHTTPClient(client))
	if err != nil {
		return nil, nil, fmt.Errorf("unable to create Cloud Identity service: %w", err)
	}
	return calendarService, groupsService, nil
}

func GetCalendarService() (*calendar.Service, error) {
	useScope := GetGaliScope()
	ctx := context.Background()
	config, err := getGoogleConfig(useScope)
	if err != nil {
		return nil, fmt.Errorf("unable to get Google API config: %w", err)
	}

	var client *http.Client
	options := []option.ClientOption{}
	if config != nil {
		client, err = getClient(config)
		if err != nil {
			return nil, fmt.Errorf("unable to get HTTP client: %w", err)
		}
		options = append(options, option.WithHTTPClient(client))
	} else {
		// Fallback to ADC
		options = append(options, option.WithScopes(useScope...))
	}
	srv, err := calendar.NewService(ctx, options...)
	if err != nil {
		return nil, fmt.Errorf("unable to create Calendar service: %w", err)
	}
	return srv, nil
}

func GetAdminDirectoryService(scope ...string) (*admdir.Service, error) {
	useScope := GetGaliScope()
	ctx := context.Background()
	config, err := getGoogleConfig(useScope)
	if err != nil {
		return nil, fmt.Errorf("unable to get Google API config: %w", err)
	}

	var client *http.Client
	options := []option.ClientOption{}
	if config != nil {
		client, err = getClient(config)
		if err != nil {
			return nil, fmt.Errorf("unable to get HTTP client: %w", err)
		}
		options = append(options, option.WithHTTPClient(client))
	} else {
		// Fallback to ADC
		options = append(options, option.WithScopes(useScope...))
	}
	srv, err := admdir.NewService(ctx, options...)
	if err != nil {
		return nil, fmt.Errorf("unable to create Admin Directory service: %w", err)
	}
	return srv, nil
}
