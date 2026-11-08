# Violinist output parser

A dependency-free GitHub Action that turns Violinist's JSON debug log into a short, readable report:

- **Available updates**: from → to, update type, direct/indirect, and what happened to each one (PR created/updated/already exists/failed, with a link when there is one)
- **Per-package details**: branch, notes, errors and lock file changes
- **Security advisories**, sorted by severity, with CVE and link
- **Errors and warnings**, also as workflow annotations
- Noise such as composer/git output, licence checks and the "not in allow list" lines is dropped or collapsed

It prints this to the log and writes a Markdown version to the **job summary**.

## Usage

Pass the `json` output of `violinist-dev/update-action` straight in:

```yaml
- uses: violinist-dev/update-action@1.x
  id: update
  with:
    php_version: "8.3"
  env:
    USER_TOKEN: ${{ secrets.GH_PRIVATE_USER_TOKEN }}
    PROJECT_URL: ${{ github.repositoryUrl }}
    LICENCE_KEY: ${{ secrets.VIOLINIST_LICENSE }}

- name: Violinist report
  if: always()
  uses: andeersg/violinist-output-parser@v1
  with:
    json: ${{ steps.update.outputs.json }}
```

> **Don't** put the output in an environment variable (`env: JSON_OUTPUT: ${{ steps.update.outputs.json }}`).
> Linux limits one env var to 128 KB, so big runs fail with "Argument list too long" before any code runs.
> This is a composite action, so `json` reaches the script without going through the environment.

Requires `node` on the runner. It's preinstalled on GitHub-hosted runners.

### Inputs

| Input | Default | Description |
|---|---|---|
| `json` |  | The Violinist output (`${{ steps.update.outputs.json }}`) |
| `file` |  | Path to a JSON file instead |
| `summary` | `true` | Write the job summary |
| `show-other` | `true` | Show unclassified messages in a collapsed group |
| `annotate-warnings` | `false` | Also annotate warnings |
| `fail-on-error` | `false` | Fail the step if Violinist logged errors |

### Outputs

`updates-count`, `advisories-count`, `errors-count`.

## Local use

```sh
node index.js example.json
cat output.json | node index.js
```
