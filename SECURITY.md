# Security policy

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability.

Use [GitHub's private vulnerability reporting](https://github.com/luka-zivkovic/dailies/security/advisories/new)
or email [lukazivkovic58@gmail.com](mailto:lukazivkovic58@gmail.com). Include a
clear description, affected version, reproduction steps, and the potential
impact when possible.

You will receive an acknowledgement after the report has been reviewed. Please
allow time for a fix and coordinated disclosure before publishing details.

## Supported versions

Dailies is pre-1.0 software. Security fixes are applied to the latest published
version; older releases may not receive backports.

## Sensitive evaluation data

Dailies reports may contain evaluation inputs, candidate outputs, labels, and
judge reasons. Store and share those artifacts according to the sensitivity of
the underlying data. Authentication header values should remain in private
configuration or secret storage and must not be committed to the repository.
