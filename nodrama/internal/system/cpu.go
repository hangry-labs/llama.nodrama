package system

import (
	"errors"
	"os"
	"runtime"
	"strconv"
	"strings"
)

type ContainerCPUStats struct {
	UsageUsec uint64
	CPUs      float64
}

func ReadContainerCPUStats() (ContainerCPUStats, error) {
	if runtime.GOOS != "linux" {
		return ContainerCPUStats{}, errors.New("container cpu stats are only available on linux")
	}
	usage, err := readCgroupUsageUsec("/sys/fs/cgroup/cpu.stat")
	if err != nil {
		return ContainerCPUStats{}, err
	}
	return ContainerCPUStats{
		UsageUsec: usage,
		CPUs:      readCgroupCPUQuota("/sys/fs/cgroup/cpu.max"),
	}, nil
}

func readCgroupUsageUsec(path string) (uint64, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0, err
	}
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) != 2 || fields[0] != "usage_usec" {
			continue
		}
		return strconv.ParseUint(fields[1], 10, 64)
	}
	return 0, errors.New("usage_usec not found in cpu.stat")
}

func readCgroupCPUQuota(path string) float64 {
	data, err := os.ReadFile(path)
	if err != nil {
		return float64(runtime.NumCPU())
	}
	fields := strings.Fields(string(data))
	if len(fields) < 2 || fields[0] == "max" {
		return float64(runtime.NumCPU())
	}
	quota, errQuota := strconv.ParseFloat(fields[0], 64)
	period, errPeriod := strconv.ParseFloat(fields[1], 64)
	if errQuota != nil || errPeriod != nil || quota <= 0 || period <= 0 {
		return float64(runtime.NumCPU())
	}
	return quota / period
}
