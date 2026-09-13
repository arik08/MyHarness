"""Sample this web server's process tree. stdin EOF ends the helper with its parent."""

import json
import os
import sys

import psutil


def sample(root):
    memory = psutil.virtual_memory()
    rss = 0
    count = 0
    partial = False
    for process in [root, *root.children(recursive=True)]:
        try:
            rss += process.memory_info().rss
            count += 1
        except psutil.NoSuchProcess:
            continue
        except psutil.AccessDenied:
            partial = True
    return {
        "cpuPercent": psutil.cpu_percent(),
        "totalMemoryBytes": memory.total,
        "availableMemoryBytes": memory.available,
        "appMemoryBytes": rss,
        "processCount": count,
        "partial": partial,
    }


def main():
    root = psutil.Process(int(sys.argv[1]))
    # Do not accept arbitrary processes from web requests: this is our direct parent.
    if root.pid != os.getppid():
        raise SystemExit("Expected parent process")
    psutil.cpu_percent()
    first = True
    for _ in sys.stdin:
        try:
            value = sample(root)
            if first:
                value["cpuPercent"] = None  # No meaningful interval on the first sample.
            first = False
            print(json.dumps(value), flush=True)
        except psutil.Error:
            print(json.dumps({"error": "resource_sample_unavailable"}), flush=True)


if __name__ == "__main__":
    main()
