#!/usr/bin/env python3
"""Simple HTTP server for the map balance web tool."""

import http.server
import os
import sys

PORT = 8080

os.chdir(os.path.dirname(os.path.abspath(__file__)))

handler = http.server.SimpleHTTPRequestHandler
handler.extensions_map.update({
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.css': 'text/css',
})

server = http.server.HTTPServer(('localhost', PORT), handler)
print(f"Serving Si_MapBalance tool at http://localhost:{PORT}")
print("Press Ctrl+C to stop")

try:
    server.serve_forever()
except KeyboardInterrupt:
    print("\nStopped.")
    sys.exit(0)
