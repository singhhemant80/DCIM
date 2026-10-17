# GeoIP test databases

`GeoIP2-City-Test.mmdb` and `GeoLite2-ASN-Test.mmdb` are MaxMind's published
test databases from https://github.com/maxmind/MaxMind-DB (`test-data/`),
licensed under Creative Commons Attribution-ShareAlike 4.0 by MaxMind, Inc.
They contain a handful of made-up entries (e.g. 81.2.69.142 → London,
1.128.0.1 → AS1221) and are used only by tests and the development flow
simulator. Production uses DB-IP Lite, downloaded by the worker.
