package gpu

import (
	"bytes"
	"context"
	"encoding/csv"
	"errors"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

type Snapshot struct {
	Available bool      `json:"available"`
	Error     string    `json:"error,omitempty"`
	UpdatedAt time.Time `json:"updatedAt"`
	Devices   []Device  `json:"devices"`
}

type Device struct {
	Index             int     `json:"index"`
	Name              string  `json:"name"`
	UtilizationGPU    float64 `json:"utilizationGpu"`
	UtilizationMemory float64 `json:"utilizationMemory"`
	MemoryUsedMiB     float64 `json:"memoryUsedMiB"`
	MemoryTotalMiB    float64 `json:"memoryTotalMiB"`
	TemperatureC      float64 `json:"temperatureC"`
	PowerDrawW        float64 `json:"powerDrawW"`
	PowerLimitW       float64 `json:"powerLimitW"`
}

func Collect(ctx context.Context) Snapshot {
	now := time.Now()
	query := "index,name,utilization.gpu,utilization.memory,memory.used,memory.total,temperature.gpu,power.draw,power.limit"
	cmd := exec.CommandContext(ctx, "nvidia-smi", "--query-gpu="+query, "--format=csv,noheader,nounits")
	out, err := cmd.Output()
	if err != nil {
		if errors.Is(err, exec.ErrNotFound) {
			return Snapshot{UpdatedAt: now, Error: "nvidia-smi not found"}
		}
		return Snapshot{UpdatedAt: now, Error: strings.TrimSpace(err.Error())}
	}

	reader := csv.NewReader(bytes.NewReader(out))
	reader.TrimLeadingSpace = true
	records, err := reader.ReadAll()
	if err != nil {
		return Snapshot{UpdatedAt: now, Error: err.Error()}
	}

	devices := make([]Device, 0, len(records))
	for _, record := range records {
		if len(record) < 9 {
			continue
		}
		devices = append(devices, Device{
			Index:             toInt(record[0]),
			Name:              strings.TrimSpace(record[1]),
			UtilizationGPU:    toFloat(record[2]),
			UtilizationMemory: toFloat(record[3]),
			MemoryUsedMiB:     toFloat(record[4]),
			MemoryTotalMiB:    toFloat(record[5]),
			TemperatureC:      toFloat(record[6]),
			PowerDrawW:        toFloat(record[7]),
			PowerLimitW:       toFloat(record[8]),
		})
	}

	return Snapshot{Available: len(devices) > 0, UpdatedAt: now, Devices: devices}
}

func toInt(raw string) int {
	value, _ := strconv.Atoi(strings.TrimSpace(raw))
	return value
}

func toFloat(raw string) float64 {
	value, _ := strconv.ParseFloat(strings.TrimSpace(raw), 64)
	return value
}
