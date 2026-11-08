# Violinist output parser

A dependency-free GitHub Action that turns Violinist's JSON debug log into a short, readable report:

- **Available updates**: from → to, update type, direct/indirect, and what happened to each one (PR created/updated/already exists/failed, with a link when there is one)
- **Per-package details**: branch, notes, errors and lock file changes
- **Security advisories**, sorted by severity, with CVE and link
- **Errors and warnings**, also as workflow annotations
- Noise such as composer/git output, licence checks and the "not in allow list" lines is dropped or collapsed

It prints this to the log and writes a Markdown version to the **job summary**.

## Usage

The Violinist step sets `$JSON_OUTPUT`, and this action reads it by default, so add it right after:

```yaml
- name: Run Violinist
  # ...your existing violinist step...

- name: Violinist report
  uses: andeersg/violinist-output-parser@v1
```

This replaces the old `echo "$JSON_OUTPUT" > /tmp/output && cat /tmp/output | jq` step.

### Inputs

| Input | Default | Description |
|---|---|---|
| `env` | `JSON_OUTPUT` | Name of the env var that holds the JSON |
| `file` |  | Path to a JSON file instead (takes precedence) |
| `json` |  | JSON as a string instead (takes precedence) |
| `summary` | `true` | Write the job summary |
| `show-other` | `true` | Show unclassified messages in a collapsed group |
| `annotate-warnings` | `false` | Also annotate warnings |
| `fail-on-error` | `false` | Fail the step if Violinist logged errors |

### Outputs

`updates-count`, `advisories-count`, `errors-count`.

## Local use

```sh
node index.js example.json
JSON_OUTPUT="$(cat example.json)" node index.js
cat output.json | node index.js
```
