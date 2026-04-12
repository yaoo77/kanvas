# kanvas shell integration (OSC 133 + OSC 7)
#
# Source this file from your ~/.zshrc (or ~/.bashrc with minor tweaks) to
# let kanvas terminals detect prompt boundaries, exit status, and cwd
# changes. It emits:
#   OSC 133 ; A  -- before prompt (prompt start)
#   OSC 133 ; B  -- after prompt (input start)
#   OSC 133 ; C  -- before command execution
#   OSC 133 ; D ; <exitcode>  -- after command
#   OSC 7 ; file://host/<cwd>  -- on chpwd
#
# kanvas parses these to update cwd, exit badges, and the event log.

if [[ -n $KANVAS_SHELL_INTEGRATION ]]; then
  return
fi
export KANVAS_SHELL_INTEGRATION=1

__kanvas_prompt_start() {
  print -nP '\e]133;A\a'
}
__kanvas_prompt_end() {
  print -nP '\e]133;B\a'
}
__kanvas_precmd() {
  local ec=$?
  print -nP "\e]133;D;${ec}\a"
}
__kanvas_preexec() {
  print -nP '\e]133;C\a'
}
__kanvas_chpwd() {
  print -nP "\e]7;file://${HOST}${PWD}\a"
}

# Emit initial cwd
__kanvas_chpwd

autoload -Uz add-zsh-hook
add-zsh-hook precmd __kanvas_precmd
add-zsh-hook preexec __kanvas_preexec
add-zsh-hook chpwd __kanvas_chpwd

# Wrap PROMPT/RPROMPT with A/B markers
if [[ -z $__KANVAS_ORIG_PROMPT ]]; then
  __KANVAS_ORIG_PROMPT=$PROMPT
  PROMPT=$'%{\e]133;A\a%}'$__KANVAS_ORIG_PROMPT$'%{\e]133;B\a%}'
fi
