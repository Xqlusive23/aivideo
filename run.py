#!/usr/bin/env python3
"""
run.py — starts a React project from Python.

Important: this script does NOT execute your React/JSX code itself.
Python can't run JavaScript. What it does is call the real tools that
run a React app (npm) on your behalf, so you only have to type one
command: `python run.py`.

Requirements:
- Node.js and npm must be installed on your machine
  (check with `node -v` and `npm -v` in a terminal)
- This script should sit in the root of your React project,
  next to package.json
"""

import subprocess
import sys
import os

def run(command):
    print(f"\n> {' '.join(command)}")
    result = subprocess.run(command, shell=(os.name == "nt"))
    if result.returncode != 0:
        print(f"\nCommand failed: {' '.join(command)}")
        sys.exit(result.returncode)

def main():
    if not os.path.exists("package.json"):
        print("No package.json found in this folder.")
        print("Run this script from the root of your React project "
              "(the folder that contains package.json).")
        sys.exit(1)

    if not os.path.exists("node_modules"):
        print("Dependencies not installed yet — running npm install...")
        run(["npm", "install"])
    else:
        print("node_modules already present — skipping npm install.")

    print("\nStarting the React dev server (npm run dev)...")
    print("Press Ctrl+C to stop.\n")
    run(["npm", "run", "dev"])

if __name__ == "__main__":
    main()