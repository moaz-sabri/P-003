# Question packs

A **pack** is a ready-made set of questions that ships inside the app. A reader browses
them at `/library` and copies one onto their own device, where its questions become
ordinary questions — editable, deletable, and attachable to as many goals as they like.

## Adding one is adding a file

Drop a `.json` file in this directory and rebuild. There is no manifest, no
registration, and no code change: `app/js/services/library-service.js` discovers every
`.json` file here with `import.meta.webpackContext`, and every `.js`/`.mjs` test in
`tests/` that reads this directory will check the new file.

The file name is the set's id and part of its URL (`/library/<file name>`), so it must be
lower case, digits and single hyphens: `arabic-alphabet.json` is the set
`arabic-alphabet`. Two sets may not share a name, folded — a reader cannot choose between
two things called "Verbs".

## The format

```json
{
  "name": "Arabic letters",
  "description": "Shown under the name on the library card.",
  "subject": "Arabic language",
  "questions": [
    {
      "text": "What is this letter: «ا»?",
      "kind": "single",
      "options": [
        { "text": "alif", "isCorrect": true },
        { "text": "ba", "isCorrect": false }
      ]
    }
  ]
}
```

| field | required | notes |
| --- | --- | --- |
| `name` | yes | Also the name of the shelf the copies are filed on, so it is held to a group's name limit (40 characters). |
| `description` | no | One sentence. |
| `subject` | no | Free text, drawn as the file wrote it. Not a translation key. |
| `questions` | yes | 1–200. A file with none is refused. |
| `questions[].text` | yes | Up to 500 characters. No two questions in one set may say the same thing. |
| `questions[].kind` | yes | `single` or `multiple` — the two kinds this app can ask. |
| `questions[].options` | yes | 2–6. At least one correct; exactly one when `kind` is `single`. |
| `options[].isCorrect` | no* | The right answer, marked on the option. |

\* The answer may also be given as a position instead, which is shorter to type:
`"answer": 2`, or `"answer": [0, 3]` for a multiple-choice question. A mark on an option
wins over the index for that option; an index that names no option is ignored rather than
guessed at, so a file that marks one option *and* gives an index is refused as having two
answers to a single-choice question.

## What is refused, and why it matters

Every question in a pack is run through `domain/validation.js`'s `validateQuestion` — the
same function the question editor's form runs. A set with one bad question is refused
**whole** and left out of the library, with the reason in the console and a line on the
library page saying a set could not be read. The alternative is shipping a question that
cannot be answered, which the reader would meet in an exercise with no way to tell the app
got it wrong rather than them.

`npm test` reads this directory and checks every file against the same rules, so a broken
set fails the build rather than a reader's phone.