
# All the Spaces: a program that stops without tidying up (one that crashed, or ran out of
# memory) can leave the terminal reporting the mouse as typed text. A shell prompt never wants
# that, so each prompt switches mouse reporting off.
__ats_mouse_off() { printf '\033[?1000l\033[?1002l\033[?1003l\033[?1005l\033[?1006l\033[?1015l'; }
PROMPT_COMMAND="__ats_mouse_off${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
