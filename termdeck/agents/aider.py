from termdeck.agents.base import AgentCli


class AiderCli(AgentCli):
    """aider — pair-programming CLI, and the registry's sessionless archetype.

    Aider has no session ids at all: it keeps one chat history per DIRECTORY
    (.aider.chat.history.md) and --restore-chat-history reloads it, so a restarted terminal
    resumes by construction without anything to detect or bind. sessionless=True is what turns
    off the machinery that assumes an id exists (detection scheduling, the restart identity
    gate, the prompt-ready wait for a new binding).
    """

    kind = "aider"
    executable = "aider"
    label = "Aider"

    sessionless = True
    supports_resume = True   # respawning the same command in the same cwd IS the resume

    base_flags = ("--restore-chat-history",)
    permission_flags = {
        "default": (),
        "auto": ("--yes-always",),
        "full-access": ("--yes-always",),
    }
    ui_permission_options = (("default", "Default (confirm actions)"), ("auto", "Auto-approve (--yes-always)"))
    permission_switch_flags = ("--yes-always",)
