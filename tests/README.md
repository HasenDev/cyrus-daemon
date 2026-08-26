# Tests

This directory is reserved for the Cyrus Panel automated test suite.

## Status

Testing is planned as a future development task and is intentionally not
implemented yet.

For now, the priority is maintaining the stability and security of the
existing codebase before introducing a full automated testing infrastructure.

## Planned Coverage

Future tests should cover, at minimum:

- Authentication and token validation
- Authorization and server permissions
- API endpoint behavior
- Input validation
- Rate limiting
- Filesystem and path security
- Server lifecycle operations
- Daemon communication
- Error handling
- Security regression cases

## Security Regression Tests

Previously discovered security vulnerabilities should receive regression
tests where practical.

This is especially important to make sure that issues that have already been
fixed do not accidentally get reintroduced during future development.

## Future Setup

The test framework, configuration, testing conventions, and CI integration
will be introduced in a future update.

Until then, this directory intentionally contains no automated tests.
