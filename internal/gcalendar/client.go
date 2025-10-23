package gcalendar

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
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
	"google.golang.org/api/option"
)

func getClient(config *oauth2.Config) (*http.Client, error) {
	usr, err := user.Current()
	if err != nil {
		return nil, fmt.Errorf("unable to get current user: %w", err)
	}
	tokenCacheDir := filepath.Join(usr.HomeDir, ".credentials")
	tokenCacheFile := filepath.Join(tokenCacheDir, "gali_token.json")

	tok, err := tokenFromFile(tokenCacheFile)
	if err != nil {
		if err := os.MkdirAll(tokenCacheDir, 0700); err != nil {
			return nil, fmt.Errorf("unable to create token cache directory: %w", err)
		}
		tok, err = getTokenFromWeb(config)
		if err != nil {
			return nil, fmt.Errorf("unable to get token from web: %w", err)
		}
		if err := saveToken(tokenCacheFile, tok); err != nil {
			return nil, fmt.Errorf("unable to save token: %w", err)
		}
	}
	return config.Client(context.Background(), tok), nil
}

func getTokenFromWeb(config *oauth2.Config) (*oauth2.Token, error) {
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
	fmt.Printf("Go to the following link in your browser:\n%v\n", url)

	codeCh := make(chan string)
	errCh := make(chan error)
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
		tok, err := config.Exchange(context.TODO(), code)
		if err != nil {
			return nil, fmt.Errorf("unable to retrieve token from web: %w", err)
		}
		return tok, nil
	case err := <-errCh:
		return nil, err
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

func saveToken(path string, token *oauth2.Token) error {
	fmt.Printf("Saving credential file to: %s\n", path)
	f, err := os.Create(path)
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
