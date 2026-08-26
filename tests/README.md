# Tests

This directory is reserved for the Cyrus Daemon automated test suite.

## Status

Testing is planned as a future development task and is intentionally not
implemented yet.

For now, the priority is maintaining the stability and security of the
existing daemon before introducing a full automated testing infrastructure.

## Planned Coverage

Future tests should cover, at minimum:

- Authentication and daemon key validation
- Server and node authorization
- API endpoint behavior
- Input validation
- Rate limiting
- Filesystem and path security
- Server installation and deletion
- Container lifecycle operations
- Docker communication
- Panel communication and callbacks
- Server resource limits
- Error handling
- Security regression cases

## Security Regression Tests

Previously discovered security vulnerabilities should receive regression
tests where practical.

This is especially important to make sure that issues that have already been
fixed do not accidentally get reintroduced during future development.

## Future Setup

The test framework, configuration, testing conventions, and CI integration will
be introduced in a future update.

Until then, this directory intentionally contains no automated tests.
