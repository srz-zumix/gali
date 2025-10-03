package render

import (
	"bytes"
	"fmt"
	"strconv"

	"github.com/cli/cli/pkg/iostreams"
	"github.com/olekukonko/tablewriter"
)

type Exporter interface {
	Export(any)
}

type Renderer struct {
	IO           *iostreams.IOStreams
	exporter     Exporter
	Color        bool
	ShowDeclined bool
}

type StringRenderer struct {
	Renderer Renderer
	Stdout   *bytes.Buffer
	Stderr   *bytes.Buffer
}

const (
	ColorFlagAlways string = "always"
	ColorFlagNever  string = "never"
	ColorFlagAuto   string = "auto"
)

var ColorFlags = []string{
	ColorFlagAlways,
	ColorFlagNever,
	ColorFlagAuto,
}

func NewRenderer() *Renderer {
	return &Renderer{
		IO:           iostreams.System(),
		ShowDeclined: false,
	}
}

func NewStringRenderer() *StringRenderer {
	io, _, out, errOut := iostreams.Test()
	return &StringRenderer{
		Renderer: Renderer{
			IO: io,
		},
		Stdout: out,
		Stderr: errOut,
	}
}

func (r *Renderer) SetColor(colorFlag string) {
	switch colorFlag {
	case ColorFlagAlways:
		r.Color = true
	case ColorFlagNever:
		r.Color = false
	default:
		r.Color = r.IO.ColorEnabled()
	}
}

func GetExporter(name string) Exporter {
	switch name {
	case "json":
		return &JSONExporter{}
	default:
		return nil
	}
}

func (r *Renderer) SetExporter(exporter Exporter) {
	r.exporter = exporter
}

func (r *Renderer) WriteLine(line string) {
	if r.exporter != nil {
		return
	}
	r.writeLine(line)
}

func (r *Renderer) writeLine(line string) {
	_, err := fmt.Fprintln(r.IO.Out, line)
	if err != nil {
		r.WriteError(err)
	}
}

func (r *Renderer) WriteError(err error) {
	fmt.Fprintf(r.IO.ErrOut, "%v\n", err) // nolint
}

func ToString(v any) string {
	if str, ok := v.(*string); ok {
		if str == nil {
			return ""
		}
		return *str
	} else if b, ok := v.(*bool); ok {
		if b == nil {
			return ""
		}
		return toString(*b)
	} else if i, ok := v.(*int); ok {
		if i == nil {
			return ""
		}
		return toString(*i)
	} else if i, ok := v.(*int64); ok {
		if i == nil {
			return ""
		}
		return toString(*i)
	} else if i, ok := v.(*int32); ok {
		if i == nil {
			return ""
		}
		return toString(*i)
	} else if i, ok := v.(*int8); ok {
		if i == nil {
			return ""
		}
		return toString(*i)
	} else if i, ok := v.(*int16); ok {
		if i == nil {
			return ""
		}
		return toString(*i)
	} else if i, ok := v.(*uint); ok {
		if i == nil {
			return ""
		}
		return toString(*i)
	} else if i, ok := v.(*uint64); ok {
		if i == nil {
			return ""
		}
		return toString(*i)
	} else if i, ok := v.(*uint32); ok {
		if i == nil {
			return ""
		}
		return toString(*i)
	} else if i, ok := v.(*uint8); ok {
		if i == nil {
			return ""
		}
		return toString(*i)
	} else if i, ok := v.(*uint16); ok {
		if i == nil {
			return ""
		}
		return toString(*i)
	} else if i, ok := v.(*float64); ok {
		if i == nil {
			return ""
		}
		return toString(*i)
	} else if i, ok := v.(*float32); ok {
		if i == nil {
			return ""
		}
		return toString(*i)
	} else if e, ok := v.(*error); ok {
		if e == nil {
			return ""
		}
		return toString(*e)
	}
	return toString(v)
}

func toString(v any) string {
	if str, ok := v.(string); ok {
		return str
	} else if b, ok := v.(bool); ok {
		if b {
			return "YES"
		}
		return "NO"
	} else if i, ok := v.(int); ok {
		return fmt.Sprintf("%d", i)
	} else if i, ok := v.(int64); ok {
		return fmt.Sprintf("%d", i)
	} else if i, ok := v.(int32); ok {
		return fmt.Sprintf("%d", i)
	} else if i, ok := v.(int8); ok {
		return fmt.Sprintf("%d", i)
	} else if i, ok := v.(int16); ok {
		return fmt.Sprintf("%d", i)
	} else if i, ok := v.(uint); ok {
		return fmt.Sprintf("%d", i)
	} else if i, ok := v.(uint64); ok {
		return fmt.Sprintf("%d", i)
	} else if i, ok := v.(uint32); ok {
		return fmt.Sprintf("%d", i)
	} else if i, ok := v.(uint8); ok {
		return fmt.Sprintf("%d", i)
	} else if i, ok := v.(uint16); ok {
		return fmt.Sprintf("%d", i)
	} else if f, ok := v.(float64); ok {
		return fmt.Sprintf("%f", f)
	} else if f, ok := v.(float32); ok {
		return fmt.Sprintf("%f", f)
	} else if i, ok := v.(error); ok {
		return i.Error()
	}
	return ""
}

func ToRGB(c string) (int, int, int, error) {
	if len(c) != 6 {
		return 0, 0, 0, fmt.Errorf("invalid color code: %s", c)
	}
	r, err := strconv.ParseInt(c[:2], 16, 32)
	if err != nil {
		return 0, 0, 0, err
	}
	g, err := strconv.ParseInt(c[2:4], 16, 32)
	if err != nil {
		return 0, 0, 0, err
	}
	b, err := strconv.ParseInt(c[4:6], 16, 32)
	if err != nil {
		return 0, 0, 0, err
	}
	return int(r), int(g), int(b), nil
}

func (r *Renderer) newTableWriter(header []string) *tablewriter.Table {
	table := tablewriter.NewWriter(r.IO.Out)
	table.SetHeader(header)
	return table
}
