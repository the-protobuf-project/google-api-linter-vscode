/**
 * Default configuration template for .api-linter.yaml files.
 * Contains commented examples of common configuration options.
 */
export const CONFIG_TEMPLATE = `# Protobuf AIP Linter Configuration
# See: https://linter.aip.dev/configuration
# Config must be an array of rule blocks (api-linter lint.Configs).
# Paths in included_paths / excluded_paths are relative to this file.

- included_paths:
    - "**/*.proto"
  # Disable specific rules
  disabled_rules:
    - core::0192::has-comments
  # Enable specific rules (optional)
  # enabled_rules:
  #   - custom::rule::name

# Turn a whole folder off: "all" is every rule at once.
# - included_paths:
#     - "vendor/**/*.proto"
#   disabled_rules:
#     - all
`;

/** Glob pattern for matching Protocol Buffer files */
export const PROTO_FILE_PATTERN = "**/*.proto";

/** File extension for Protocol Buffer files */
export const PROTO_FILE_EXTENSION = ".proto";

/** Default configuration file name */
export const CONFIG_FILE_NAME = ".api-linter.yaml";

/** Workspace proto config file (enables extension and proto paths) */
export const WORKSPACE_PROTOBUF_YAML = "workspace.protobuf.yaml";

/** Display name of the extension */
export const EXTENSION_NAME = "Protobuf AIP Linter";

/** Source identifier for diagnostics */
export const DIAGNOSTIC_SOURCE = "protobuf-aip-linter";

/** Name of the output channel for logging */
export const OUTPUT_CHANNEL_NAME = "Protobuf AIP Linter";
