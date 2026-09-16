// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

export const cordisSequenceConformance = `
- id: webserver
  host: '127.0.0.1'
  port: 19000
- insert:
    - id: tool-cordis
      name: '@deepseek-ai/dsh-tool-cordis'
      enabled: true
- id: local-helper
  name: '@example/independent-helper'
`;

export const ecosystemFailureFixtures = {
  opencode: {
    malformed: '{"schemaVersion":',
    hostile: '{"apiKey":"do-not-read","command":"!read-secret"}',
    unknownVersion: '{"schemaVersion":"999"}',
  },
  dsh: {
    malformed: "- id\n  name: broken\n",
    hostile: "- id: unsafe\n  value: !javascript/function payload\n",
    unknownVersion: "version: 999\n- id: safe\n  name: '@example/safe'\n",
  },
  claudeCode: {
    malformed: '{"schemaVersion":',
    hostile: '{"apiKey":"do-not-read","hook":"!read-secret"}',
    unknownVersion: '{"schemaVersion":"999"}',
  },
} as const;
