export function detectCommand(prompt) {
  const match = /^([/$])(kiro-[a-z0-9-]+)(?=\s|$)/.exec(prompt.trimStart());
  return match ? { skill: match[2], sigil: match[1] } : null;
}

export function skillPath(tool, skill) {
  const directory = tool === "claude" ? ".claude" : ".agents";
  return `${directory}/skills/${skill}/SKILL.md`;
}

export function isExpandedInvocation(tool, sigil, skill, listed) {
  return ((tool === "claude" && sigil === "/") || (tool === "codex" && sigil === "$"))
    && listed.includes(skill);
}
