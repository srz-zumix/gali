package render

import (
	"encoding/json"
	"fmt"
	"log"
)

func OutputJSON(events any) {
	b, err := json.MarshalIndent(events, "", "  ")
	if err != nil {
		log.Fatalf("Failed to marshal events to JSON: %v", err)
	}
	fmt.Println(string(b))
}

type JSONExporter struct{}

func (j *JSONExporter) Export(data any) {
	OutputJSON(data)
}
