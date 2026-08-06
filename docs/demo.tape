# Regenerate docs/demo.gif:  vhs docs/demo.tape   (needs vhs + ttyd + ffmpeg)
# Runs `bun run demo` — the setup screen against fixture cameras, no phone attached.

Output docs/demo.gif

Set Shell "bash"
Set FontSize 14
Set Width 1240
Set Height 580
Set Padding 20
Set Framerate 24
Set TypingSpeed 60ms

Type "bun run demo"
Sleep 800ms
Enter
Sleep 3s

# camera column — the list is probed off the phone
Down
Sleep 1.2s
Down
Sleep 1.2s
Up
Up
Sleep 1s

# resolution column: 2 jumps to it, / filters
Type "2"
Sleep 800ms
Type "/"
Sleep 400ms
Type "1280"
Sleep 1.5s
Enter
Down
Sleep 1.5s
Escape
Sleep 1s

# output column: 3 jumps to fps, → walks up to the high-speed rates
Type "3"
Sleep 800ms
Right
Sleep 500ms
Right
Sleep 500ms
Right
Sleep 500ms
Right
Sleep 1.5s

# zoom
Tab
Sleep 500ms
Right
Sleep 400ms
Right
Sleep 400ms
Right
Sleep 2.5s

Hide
Ctrl+C
