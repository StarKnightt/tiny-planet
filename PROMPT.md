# The prompt

The prompt this game was built from, as given to Claude Code:

```text
build a tiny planet i can fly and walk around in the browser. three.js + vite + typescript, pnpm. use opus 5.5 subagents for the parallel work.

a small round world like mario galaxy: ocean and beaches, rolling grass hills that sway, a pine forest, a little village with a lighthouse, a windmill that turns, clouds orbiting overhead. a day/night sweep so one side of the planet is always sunset, and at night the windows and lighthouse light up. wasd + mouse to walk, gravity pulls to the center so i can walk all the way around.

everything made in code, no downloaded assets. it must look like a finished cozy indie game, not a demo. 60 fps on my rtx 4060.

check your own work with screenshots and fix what looks wrong.

then record the video yourself, don't make me screen record:
- render a cinematic fly-in frame by frame with a fixed time step (headless browser with playwright, capture every frame, encode with ffmpeg), so it's perfectly smooth no matter the fps
- 1920x1080, 60 fps, about 20 seconds: start in space, dive down through the clouds, sweep over the ocean and hills, end low over the village at sunset with the lights coming on
- add a soft ambient sound bed made in code (wind, waves, a few birds), no downloaded audio
- save it to E:\Final-Video\tiny-planet.mp4 and show me 6 frames from it so i can check it before posting
```
