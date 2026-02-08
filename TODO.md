
# TODO

## UI
- add loading state while refreshing data
- general revamp to modern simple minimalistic design


## Features
### Integrate volume/reverb extension sync (or make this the content.js of the current extension)
Introduce volume, reverb, speed... etc. controls.

This requires central storing on the extension itself. Need to handle multiple tab audio instances without breaking.

The current `./.extension-todo-controls` contain a prototype (still needs minor modifications), but this still needs updates to handle sync to the `./chrome-extension/background.js`


### Scope based QR code and tokens
Currently the frontend/ui gives full control to all features. Could have a unique link with a token per feature.
This way you could have an Admin page that can control anything, or a User page that could suggest a next song or can only control volume... etc.

Low prio.

