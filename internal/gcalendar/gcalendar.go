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
	"google.golang.org/api/calendar/v3"
)

func getClient(config *oauth2.Config) *http.Client {
	usr, _ := user.Current()
	tokenCacheDir := filepath.Join(usr.HomeDir, ".credentials")
	os.MkdirAll(tokenCacheDir, 0700)
	tokenCacheFile := filepath.Join(tokenCacheDir, "gcal_token.json")

	tok, err := tokenFromFile(tokenCacheFile)
	if err != nil {
		tok = getTokenFromWeb(config)
		saveToken(tokenCacheFile, tok)
	}
	return config.Client(context.Background(), tok)
}

func getTokenFromWeb(config *oauth2.Config) *oauth2.Token {
	ln, err := net.Listen("tcp", "localhost:0")
	if err != nil {
		log.Fatalf("Unable to start local server: %v", err)
	}
	defer ln.Close()
	redirectURL := fmt.Sprintf("http://%s", ln.Addr().String())
	config.RedirectURL = redirectURL

	url := config.AuthCodeURL("state-token", oauth2.AccessTypeOffline)
	fmt.Printf("Go to the following link in your browser:\n%v\n", url)

	codeCh := make(chan string)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			log.Fatalf("Unable to accept connection: %v", err)
		}
		req, err := http.ReadRequest(bufio.NewReader(conn))
		if err != nil {
			log.Fatalf("Unable to read request: %v", err)
		}
		q := req.URL.Query()
		code := q.Get("code")
		fmt.Fprintf(conn, "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n認証が完了しました。ウィンドウを閉じてください。")
		conn.Close()
		codeCh <- code
	}()

	code := <-codeCh
	if code == "" {
		log.Fatalf("No code received from browser redirect")
	}
	tok, err := config.Exchange(context.TODO(), code)
	if err != nil {
		log.Fatalf("Unable to retrieve token from web: %v", err)
	}
	return tok
}

func tokenFromFile(file string) (*oauth2.Token, error) {
	f, err := os.Open(file)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	tok := &oauth2.Token{}
	err = json.NewDecoder(f).Decode(tok)
	return tok, err
}

func saveToken(path string, token *oauth2.Token) {
	fmt.Printf("Saving credential file to: %s\n", path)
	f, err := os.Create(path)
	if err != nil {
		log.Fatalf("Unable to cache oauth token: %v", err)
	}
	defer f.Close()
	json.NewEncoder(f).Encode(token)
}

func GetCalendarService(scope ...string) (*calendar.Service, error) {
	b, err := os.ReadFile("credentials.json")
	if err != nil {
		return nil, fmt.Errorf("unable to read client secret file: %w", err)
	}
	useScope := calendar.CalendarReadonlyScope
	if len(scope) > 0 {
		useScope = scope[0]
	}
	config, err := google.ConfigFromJSON(b, useScope)
	if err != nil {
		return nil, fmt.Errorf("unable to parse client secret file to config: %w", err)
	}
	client := getClient(config)
	return calendar.New(client)
}
