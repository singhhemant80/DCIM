"""Print the CSP sha256 source for the inline <script> in the built index.html."""
import base64, hashlib, re, sys
html = open(sys.argv[1], encoding="utf-8").read()
for body in re.findall(r"<script>(.*?)</script>", html, re.S):
    print("'sha256-" + base64.b64encode(hashlib.sha256(body.encode()).digest()).decode() + "'")
