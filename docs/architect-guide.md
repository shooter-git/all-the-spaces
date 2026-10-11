# Building creations: a guide for Architects

Creations are made by **your own AI assistant** — Claude Code (by Anthropic) or Codex (by OpenAI) —
using your own subscription. You describe what you'd like; your assistant builds it; you try it and
publish it. You don't need to write code.

## Your own place

**Home → Your own place → Add your own place.**

1. Give it a name and say what kind of place it is.
2. **Add the floor plan**: a straight-on photo of a paper plan, a screenshot of an estate
   agent's plan, or the architect's PDF (each page becomes a plan), with any measurements or
   scale bar readable. Pictures can be JPEG, PNG, WebP, HEIC (iPhone), AVIF, GIF or TIFF. For more than one floor, add a plan
   for each and say which floor it is; mark the stairs and any lift on each. Gardens, balconies
   and roof terraces go on the plan of the floor they're on. **No floor plan?** Add a .zip of
   photos of the outside instead (see "From photos of the outside" below).
3. **Add photos** if you can (one or two per room, from a corner, in daylight, with private
   things out of view) and say which room they're of. They help your assistant match floors,
   walls and furniture, and never appear in the space.
4. **Describe it** in your own words: which room is which, the furniture that matters to you.
5. Read the privacy note, and **Start building**. A workspace opens: press **Wake it**, **Start
   Claude Code**, and pick the first **Suggestion**.

Your assistant writes the plan and draws it over your floor plan (**Plan**, on the right). If a
wall is off, drag it into place in **Move walls** and save: your assistant sees the change.
**Pictures** shows what it has drawn: each room as you'd see it from its corners, and every model
it made, from four sides (tap one to see it larger). Whenever it has changed the place since your
last build, the Studio says so, with a **Build it** button. When it looks right, **Build it** (a
few minutes), **Walk through it**, and **Publish**. You never need to type a command: ask your
assistant in your own words, or pick a **Suggestion**. Every room starts
private to Architects: then choose who sees each room on the **Privacy** page.

Remembered another photo or plan while it's being built? **Add files** (or drop them on the
workspace page): pictures and PDFs, up to 25 MB each. They're cleaned like the others and kept
with the place, and their names are typed into the terminal for you to send with a word or two
("this is the hallway").

Got a whole set, say photos from every side with a README or a manifest saying what each one
shows? Add it as one **.zip** (up to 25 MB). It's unpacked into a folder of its own, every file
keeping its name so the README still matches, and your assistant reads the README or manifest
first. Pictures are cleaned like the others; text, JSON and PDF documents come too; anything else
is left out (you're told what). The place keeps it, like your other photos and plans: whoever
changes the place next has it too.

Until it's published, **Continue** on Home takes you back to it, and **Discard…** removes it along
with its workspace, plans and photos.

### From photos of the outside

A building you can't get a floor plan for (a car park, a shop front, a public building) can be
built from photos of the outside. Put them in one **.zip** (up to 25 MB), with:

- **Photos of every side**, taken straight on and from the corners. Street views are fine.
- **A view from above** (a satellite or aerial view with its scale bar), for the footprint.
- **Notes**: a `README.md` with what you know (how many floors, how high, what it's made of, where
  the entrances are, which photos to trust least), and ideally a `manifest.json` listing each
  photo with where it was taken and which way it looks. Your assistant then draws its model from
  exactly those spots and compares (it shows you these **photo matches** under **Pictures**).

A manifest is a list of photos (at its top, or under `"images"` or `"photos"`), each like:

```json
{ "file": "03_east-face.jpg", "lat": 51.50072, "lng": -0.12462, "heading": 290, "pitch": 10, "fov": 90 }
```

`heading` is the compass direction the photo looks (0 north, 90 east), `pitch` how far up (0 is
level), and `fov` its field of view across, in degrees (leave it out if you don't know; for a
Street View screenshot, the number before `y` in its link is the field of view top to bottom: give
it as `"vfov"`). Instead of
`lat` and `lng`, `"at": [x, z]` gives a spot in metres. Anything else in an entry (what it shows,
the date) is notes for your assistant.

Add the .zip in step 2, or later with **Add files**. Inside, the photos can't show it: your
assistant makes its best guess for what's usual in that kind of building and tells you which
parts are guesses, so you can correct them, or add a floor plan when you have one.

With several floors, **Plan** has a tab for each, with its own drawing to check against. Stairs
run between floors inside a stairwell, and a lift stops at a room on each floor it serves.

### Changing your place later

Rooms, floors and furniture can change at any time: **Studio → The place itself → Change this
place…**, and say what should change ("add the attic as a new floor", "the sofa is by the window
now"). Your assistant starts from the plan of the live version and changes only what you asked.
**Build the changes** shows you what's different (rooms added, changed or removed; furniture added,
moved or removed) and lets you walk through it. Rooms you didn't change are rebuilt exactly as they
were, so they look the same and their creations stay put. New rooms start private to Architects.

If furniture holding a creation is gone in the new version, you choose for each creation before
publishing: put it on another free object, or **on the shelf**. Creations on the shelf can't be
opened, but nothing they saved is lost; **Creations → On the shelf → Place on…** brings one back.
**Move** on any creation puts it on a different object.

Every version that has been live is kept: **Versions → Go back to this** makes an earlier one live
again, with every creation back where it was then.

**Studio → Settings → Delete a place's floor plans and photos once it's published** removes them
(and the workspace that held copies) as soon as you publish. The plan your assistant wrote is kept,
so changes later still work; you'd only add new photos if a room is rebuilt from scratch.

Your place is always built as a model (walls, floors, furniture, lighting), never from the photos
themselves: photos never appear in it. Your assistant makes the furniture look like yours:
everyday pieces come from a free library of real, photographed furniture, and anything personal
(a figurine, a particular desk, a model car) it models itself in Blender, checking each one
against your photos. It can also draw a room as you'd see it standing in its corners, to compare
with the photos before you build. Just ask: "make the astronaut on the study desk look like the
one in the photo".

Each model is checked when the place is built (its size, its detail and what's in the file), so
rooms still load quickly on a phone.

## 1. Connect your assistant (once)

**Home → Your group → AI assistants.** Pick Claude Code or Codex. (The same page shows when an
update is ready: **Update to …** installs it and keeps your sign-in.)

1. **Install.** This runs the assistant's own official installer in your private container. It
   takes about a minute.
2. **Sign in.** A terminal opens with the assistant's own sign-in. Follow the steps beside it: you
   open a link, sign in with your Claude or ChatGPT account, and (for Claude) paste back a code.
   All the Spaces never sees your password or your sign-in.
3. Press **I've signed in**.

You'll need a subscription that includes the assistant (a Claude plan with Claude Code, or a
ChatGPT plan with Codex).

### Which assistant, model and effort

Whenever you start a workspace (a new creation, improving one, a member's request, a new place or
a change to one), you choose:

- **Who builds it**: Claude Code or Codex (once you've connected both);
- **the model**, in its maker's own names (Fable, Opus, Sonnet and Haiku for Claude Code; GPT-6.1
  Sol, Astra, Sol and Luna for Codex), or **Other…** for any name the assistant accepts;
- **the effort**: how long it thinks before acting (Claude Code: Low to Max; Codex: Low to Ultra,
  which splits big tasks across helpers).

Leave them on the group's default to use **Studio → Settings**, where you set the defaults for
each assistant. A workspace shows what it's using in its header: click it to change, for the next
time the assistant starts (or type `/model` in the terminal to change it in a conversation that's
already going).

### What your assistant can reach

Workspaces reach the assistants' makers, npm, free model and texture libraries, GitHub's files,
and reference pictures and docs. **Studio → Settings → Let assistants use the whole internet**
lets them reach any website while they work, which helps them find references and resources. It
also means a web page could mislead them, so it's off unless you choose it. It takes effect the
next time a workspace wakes. Workspaces never reach your server's own network, and creations
never use the internet either way.

## 2. Start a creation

**Home → Studio → A new creation.** Give it a name, say in your own words what it should be (as
much or as little as you like), and choose the object in your space it lives on. This makes a
**workspace**: its files, a terminal and a live preview.

## 3. Build it with your assistant

Open the workspace and press **Wake it**, then **Start Claude Code** (or Codex).

- **Talk to it in the terminal.** Type what you want and press Enter. Not sure what to say? Pick
  one of the **Suggestions**: it's typed in for you, and nothing is sent until you press Enter.
  On a phone, swipe the terminal up and down to scroll back through the conversation; **Live**
  takes you back to the newest.
- **Watch the preview.** It rebuilds whenever your assistant saves a file. Switch between
  **Phone** and **Laptop** to see both.
- **Files** shows, as folders, the files your assistant has made, changed or removed since the
  workspace started, and keeps up as it works (what's just changed is highlighted for a moment).
  It's a tab on a phone, and a button next to **Run checks** on a bigger screen, where it takes the
  preview's place until you press it again. Choose a file to see what's in it: its text, or the
  picture (other kinds, like 3D models, can't be shown here). **Look again** shows its latest.
- **Run checks** tries the creation the way publishing will (on phones, a tablet and a laptop) and
  lists anything to fix; **Ask to fix it** types a request for your assistant. Your assistant can
  run the same checks itself — the first suggestion asks it to build the creation, then fix
  everything the checks report.
- **Add files** (or drop them anywhere on the workspace page) to give your assistant a picture, a
  sketch, a sound or a document, up to 25 MB each. They go into the workspace's `uploads/`
  folder, and their names are typed into the terminal, not sent: add what you'd like done with
  them ("use this as the sky") and press Enter. They're listed above the terminal under **Added
  files**: tap one to put its name in the terminal again, or its bin to remove it (a place keeps
  its copy with its photos and plans). Photos lose their location and camera
  details on the way in. A **.zip** is unpacked into a folder of its own, its files keeping their
  names and folders (so a README or manifest in it still matches), and listed as that folder. Uploads aren't published as they are: your assistant copies in what the creation
  uses.
- **Carry on** picks up your last conversation after a break.
- **Checkpoints.** Your assistant saves its work as it goes (a commit in the workspace's own
  history each time something you asked for works), and the Studio saves whatever's left each
  time the workspace goes to sleep. To go back to an earlier version, ask your assistant ("go back
  to how it was before the new sounds"). History stays in the workspace; a place's floor plans
  and photos and your added files are never in it.

A workspace stays awake while you're there: its page open and in use, even if you're only
watching your assistant work or trying the preview. Once you step away it goes to sleep after a
while quiet (everything is kept), or after a few hours however busy your assistant is; a few
minutes before, its page says so, with **Stay awake**. Opening it again wakes it (unless you put
it to sleep yourself: then press **Wake it**), carries on, and brings your assistant's
instructions up to date with the platform's newest tools and advice (notes your assistant keeps
in its own section of them stay as they are).

## 4. Publish

**Publish…** checks the creation first: a clean build, then it's played on phones, a tablet and a
laptop and measured against what a modest phone can handle. Nothing reaches anyone unless it
passes.

- **Check it, and let me try it first** keeps it as a *candidate*. Go to **Creations**, press
  **Try** on your own phone or computer, then **Make live**.
- **Check it, and make it live if it passes** publishes straight away.

If it doesn't pass, **Report** explains what to fix, and **Ask to fix it** types a request for your
assistant.

## 5. Change it later

In **Creations**, press **Improve** on a creation and say what should change. Your assistant starts
from the live version. People's saved progress keeps working (your assistant is asked to make sure
of it), and anyone inside the old version is offered to rejoin the new one.

If a new version isn't right, press **Go back to this** on an earlier one.

### A creation that lives in a repository

If your server's owner allows it ([repositories.md](repositories.md)), a creation can come straight
from a git repository and follow it, instead of being built in the Studio. In **Creations**, press
**From a repository**, choose the object, the repository and the folder its creation is in, and
what to follow (the newest release, the newest on a branch, or one commit). A creation already
there can follow one too (the link button on it).

Its card then shows the repository and whether there's something newer (you're also told when a
new release turns up). **Update** fetches it,
checks it like any version and builds it: it waits for you to try it, or goes live once it passes,
as you chose. Each version says which commit it came from, and **Go back to this** works as usual.
Improving it in the Studio instead stops it following the repository (you're asked first).

## Requests from members

Anyone in the group can ask for something: in a space they press **Ask for something**, draw a box
around an object (or tap it), and say what they'd like (up to 10,000 characters), with a picture of
what they picked and, if they like, a sketch, photos, or up to three Markdown or text documents
(50,000 characters each) for a plan too long for the box. They can also **Suggest a change** to a creation, or say
**Something's wrong** with it. Nothing is built when they ask: it waits for you.

**Home → Requests to build** (or **Studio → Requests**) lists them: waiting ones first, the most
important at the top, then the longest-waiting.

- **Accept** it (with a note, if you like), or **Decline…** with a word of why. They're told
  either way.
- Set its **priority** and **how big it is**, and edit **the brief your assistant reads**. It
  starts as their words; their words, documents and pictures always go into the workspace as well
  (in `request/`, listed in `BRIEF.md`).
- **Start building** makes a workspace for it (with the creation as it is now, for a change or a
  problem). Then carry on as in steps 3 and 4: nothing runs until you start your assistant.
- It follows along by itself: "Being built" while you work on it, "Nearly ready" when a candidate
  passes its checks, and **Ready to try** when it goes live, when they're told and can go straight
  to it.

In **Privacy**, you can choose who may ask for things in each room: anyone who can see it, only its
owner (a bedroom, an office), or only Architects. Anyone who can see a creation can report a
problem with it.

## Notifications

The bell on Home lists what's happened: new requests for you, and for members, their requests
moving on. On **Home → Notifications** everyone can have them sent to their phone or computer
(on iPhone, after adding the app to the Home Screen) and, if the server can send email, by email.
Do Not Disturb (in chat) holds back everything but the list.

## Voice chat and smoothness

- **Voice chat**: in the space, **Talk** lets you talk to whoever is in the same room, and each
  voice comes from where that person stands; inside a creation you share, you talk to the others
  in it. Other sound dips while someone speaks. Nothing is recorded. Turn it off for your group
  under **Home → Chat**.
- **How smoothly things run**: people can choose to share how smoothly their device runs things
  (Menu → Smoothness, anonymous). Your place's Studio page and each creation's versions then show
  how it runs on people's phones, tablets and computers, and each kind of device starts at a
  quality that has run smoothly on it.

## Running your group

Everything is under **Your group** on the home page (on a phone, below your spaces):

- **People**: everyone in the group, when they joined and were last here (and, if the server
  sends email, whether they've confirmed their address yet). Make someone an
  Architect or a member, or remove them; a removed person leaves any space they're in straight
  away and rooms shared with them aren't any more (their account stays, so you can invite them
  back). A group always keeps at least one Architect. Invite links are made here too, for members
  or Architects, and any link still working can be turned off.
- **Group settings**: the group's name and colour, how long chat is kept, voice chat, reported
  messages, and the Studio settings (when workspaces sleep, the model and effort they start with,
  what a creation needs before it goes live). Who may see each room is set per space, under
  **Privacy** on its card.
- **AI assistants**: connect, update or disconnect Claude Code and Codex.
- **Activity**: who did what, newest first. Nothing anyone types to an assistant or in a terminal
  is recorded.
- **Server**: the version, backups, and the `ats-admin` commands for updates and restores, which
  run on the server itself.

**Your account** (for everyone): your name, password, passkeys, where you're signed in (sign other
devices out), and notifications.

### Moving a place or a creation to another server

- **A place:** in its Studio, **Download this place** gives you one `.atspace` file (usually
  5–30 MB, more with many models made for it): the building with its rooms, furniture, textures
  and lighting, the plan it was built from and the models your assistant made for it, with their
  Blender scripts (so it can be changed later). Not its people, chat, requests, creations, or the floor
  plans and photos you uploaded. On the other server, **Import a place** on the home page brings
  it in as a new place, with every room private to Architects until you share it.
- **A creation:** on a place's Creations page, the download icon beside it gives you one
  `.atcreation` file: its live version and its source (so it can be improved there). Not what
  anyone saved in it. **Import a creation** on the other server's Creations page puts it on the
  shelf; put it on an object to bring it into the place.

Every file is checked on the way in: anything damaged, incomplete, too big, carrying a licence the
server doesn't accept or holding something that looks like a password or key is refused. An
imported creation hasn't been through this server's checks, so its version says "Imported: not
checked on this server"; versions you make by improving it here are checked as usual.

Sample spaces and places that couldn't be built can be removed from their card (the ✕, or
**Remove…**). A sample that creations or requests belong to stays.

## Good to know

- **Your assistant only sees the creation's own files** — not your space, your group or anyone's
  messages — and can only reach its maker, the npm package registry and free asset libraries. If
  it tries anywhere else, the workspace tells you.
- **"Has changed since you installed it"**: the assistant program in your container isn't what
  you installed, so it wasn't started. Reinstall it from **Your group → AI assistants**.
- **Creations have no internet at all.** Everything they need is packed inside them.
