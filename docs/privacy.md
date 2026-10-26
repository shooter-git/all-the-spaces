# Privacy

Homes are sensitive, so All the Spaces is private by default:

- Only people in your group can see your space. Joining needs an invite link from an Architect.
- Rooms can be visible to everyone in the group, to chosen people, or to Architects only; new rooms
  start as Architects only. This is enforced on the server, and changes apply within seconds:
  - Someone who can't see a room receives nothing about it: not its name, shape, files, lighting,
    furniture credits or chat. The door to it shows as a closed door that says nothing about what's
    behind it.
  - People inside a room others can't see appear in the people list as "in a private area", never
    as an avatar, and the server ignores anyone claiming to be somewhere they may not see.
  - Every room is built and lit on its own with its doors closed, so hiding one never affects
    another.
- Floor plans and photos you give to build your place are saved again without location, camera
  or other hidden details, and only Architects can see them (or remove them). The one exception
  is the Architect's own choice: for a .zip of photos of a building's outside, they can keep
  **where each photo was taken** (its position, the way it faces and its lens, nothing else), in a
  `photo-positions.json` kept beside the photos, so the assistant can check its model against them.
  It's off unless they turn it on, and the pictures themselves are still saved without it. They're only ever
  read by your AI assistant, to understand the place: **they never appear in the space.** An
  Architect can have them deleted automatically as soon as a place is published (Studio →
  Settings), along with the workspace that held copies; the plan is kept.
- While an Architect builds or changes the space, the photos they choose are shared with **their own
  AI assistant provider** (for example Anthropic or OpenAI) under that provider's terms. The app says
  so before anything is sent.
- Because photos never appear in the space, nothing in them (faces, documents, screens) reaches
  anyone through it. The assistant is told not to copy personal details into the plan, and a new
  place starts with every room private to Architects until they share it.
- **Requests** (a member asking for something) are seen only by the member who asked and the
  group's Architects. The picture of what they picked, a sketch and photos are saved again without
  location or camera details; documents they attach are kept as the text they wrote. When an
  Architect builds a request, its words, pictures and documents go into the workspace, so **the Architect's AI assistant provider** sees them too. Other members only see
  that something has been asked for on an object in a room they can see ("someone asked for
  something here"), never who asked or what.
- **Notifications** are kept in the app for each person. If you turn them on for a device, the
  app's server hands them to that browser's own push service (Google for Chrome and Android,
  Apple for Safari and iPhone, Mozilla for Firefox, Microsoft for Edge on Windows), which delivers
  them. Their text is encrypted for your device: the push service can't read it. It only sees that
  a notification was sent, and when. Email notifications, if you ask for them, and the link that
  confirms your email address go through the email server the server's owner set up. Signing out stops notifications on that device.
- Chat history is kept for as long as the Architect chooses (three months unless they change it;
  older messages are deleted every night). Room chat is readable only by people who can see the
  room. Anyone can block someone (they see nothing from them, and neither can message the other),
  mute a conversation, turn on Do Not Disturb, or report a message to the Architects.
- Personal data in creations (for example a private journal) is readable only by its owner through
  the app. Whoever runs the server can, like with any self-hosted software, technically access the
  raw database.
- **Voice chat** is off until you choose to talk, and only people in the same room (or the same
  creation session) hear you. It goes through your group's server, is never recorded, and an
  Architect can turn it off for the group.
- **Time spent here** is recorded on your server, for your group's Architects: who was in which
  room of a place, or in which creation, from when to when; the kind of device (phone, tablet,
  computer or headset, nothing more about it); and, in a creation, which live session it was, so
  people playing together can be told from people playing alone. Never where in a room, or what
  they did or said. It only counts while the app is open and in sight (not in another tab or on a
  locked phone), and a room only once someone has stayed a few seconds. Architects see what it
  adds up to, on the place's Studio page (**Time spent**): when people come, how many times and
  for how long, time in each room and creation, the moves between rooms, how much of it was spent
  with someone else, the kinds of device, and the same for each person; and each person's time on
  **People**. Members don't see it. It never leaves your server, and it's deleted after 90 days.
  An Architect can turn it off for the group (Group settings → Record where people spend time),
  which also deletes what was recorded.
- The app sends no analytics or telemetry anywhere. The AI assistants' own usage statistics and
  error reports to their makers are off unless an Architect turns them on (Studio → Settings).
  Sharing how smoothly things run is a choice made on each device (Menu → Smoothness): samples say
  only what kind of device it is (phone, tablet or computer; its system; how many processor cores)
  and how smoothly the space or a creation ran, with no name or account. They stay on your server
  and are deleted after 90 days.
- When the server is behind NAT, installing and updating it asks `api.ipify.org` for the server's
  public IP address. A server installed without a domain name uses a free address,
  `<its-ip>.sslip.io`: each device that opens the space looks that name up on the public DNS
  service sslip.io. See [Self-hosting](self-hosting.md#install).
