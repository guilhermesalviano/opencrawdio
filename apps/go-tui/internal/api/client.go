package api

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Event types sent by the SSE server.
type EventType string

const (
	EventProgress EventType = "progress"
	EventContent  EventType = "content_block_delta"
	EventDone     EventType = "done"
	EventError    EventType = "error"
)

// Event represents a parsed SSE message from /api/chat.
type Event struct {
	Type    EventType
	Text    string
	Status  string
	IsError bool
}

// HealthResponse is returned by GET /health.
type HealthResponse struct {
	Status    string `json:"status"`
	Timestamp string `json:"timestamp"`
	Details   string `json:"details"`
}

// Client talks to the koris-agent web server.
type Client struct {
	BaseURL    string
	HTTPClient *http.Client
}

func NewClient(baseURL string) *Client {
	return &Client{
		BaseURL: strings.TrimRight(baseURL, "/"),
		HTTPClient: &http.Client{
			Timeout: 0, // streaming — no overall timeout
		},
	}
}

// Health checks the /health endpoint.
func (c *Client) Health() (*HealthResponse, error) {
	req, err := http.NewRequest("GET", c.BaseURL+"/health", nil)
	if err != nil {
		return nil, err
	}

	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var h HealthResponse
	if err := json.NewDecoder(resp.Body).Decode(&h); err != nil {
		return nil, err
	}
	return &h, nil
}

// Chat sends a message and returns a channel of Events (closed when done or on error).
func (c *Client) Chat(message string) (<-chan Event, error) {
	body, _ := json.Marshal(map[string]string{"message": message})

	req, err := http.NewRequest("POST", c.BaseURL+"/api/chat", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("Cache-Control", "no-cache")

	// Use a client without a read timeout so the stream stays open.
	streamClient := &http.Client{Timeout: 0}
	resp, err := streamClient.Do(req)
	if err != nil {
		return nil, err
	}

	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		return nil, fmt.Errorf("server returned %d", resp.StatusCode)
	}

	ch := make(chan Event, 32)
	go func() {
		defer resp.Body.Close()
		defer close(ch)

		scanner := bufio.NewScanner(resp.Body)
		scanner.Buffer(make([]byte, 1<<20), 1<<20)

		for scanner.Scan() {
			line := scanner.Text()
			if !strings.HasPrefix(line, "data: ") {
				continue
			}
			data := line[len("data: "):]
			if data == "[DONE]" {
				ch <- Event{Type: EventDone}
				return
			}

			var raw struct {
				Type  string `json:"type"`
				Delta struct {
					Text   string `json:"text"`
					Status string `json:"status"`
				} `json:"delta"`
			}
			if err := json.Unmarshal([]byte(data), &raw); err != nil {
				continue
			}

			switch raw.Type {
			case "progress":
				ch <- Event{Type: EventProgress, Status: raw.Delta.Status}
			case "content_block_delta":
				ch <- Event{Type: EventContent, Text: raw.Delta.Text}
			}
		}

		if err := scanner.Err(); err != nil && err != io.EOF {
			ch <- Event{Type: EventError, Text: err.Error(), IsError: true}
		}
	}()

	return ch, nil
}

// WaitForServer polls /health until the server responds or timeout expires.
func WaitForServer(baseURL string, timeout time.Duration) error {
	client := NewClient(baseURL)
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if _, err := client.Health(); err == nil {
			return nil
		}
		time.Sleep(300 * time.Millisecond)
	}
	return fmt.Errorf("server at %s did not become ready within %s", baseURL, timeout)
}
