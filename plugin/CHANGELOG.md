# Changelog

## 1.7.0

- Unified dictionary and neural predictions in TilType AI. Choose word completion,
  phrase completion or the experimental GRU phrase decoder in settings.
- Added thematic phrase suggestions across 24 topics in Russian, Kazakh and English.
- Added an optional floating formatting toolbar for selected text in Document Editor.

- Added Marketplace metadata, screenshots and third-party license notices.
- Updated the settings dialog to use plugin-local events.

- Changed suggestion acceptance to Tab and synced the key hint with the highlighted option.
- Improved phrase suggestions using local completion context and earlier document text.

- Fixed layout correction losing its result when next-word prediction was enabled.
- Expanded detection of three-letter words typed in the wrong layout.

- Added offline fallback predictions for rare phrases and unseen words.
- Expanded prediction contexts to six preceding words and learned sentence starts separately.
- Added over 137,000 measured sentence-start contexts across all three languages.
- Added 1,174 contexts found by pooling the counts of case variants.
- Added 73,807 fallback contexts based on pairs separated by one word.
- Added 35,635 fallback contexts based on pairs separated by two words.
- Added 79,136 fallback contexts selected separately for English, Russian, and Kazakh.
- Added 71,331 phrases from additional Wikipedia corpora.
- Added 68,869 Wikipedia contexts, including reserve phrases for English and Russian
  and precise phrases from a further Kazakh archive.

## 1.6.0

- Expanded offline next-word prediction to over 500,000 contexts and added
  matching based on up to three previous words.
- Added conversational and educational sentences from Tatoeba and Kazakh
  television news from KazNERD to the training data.

## 1.5.0

- Added optional offline next-word prediction in text documents, with Tab to insert.

## 1.4.1

- Added the Marketplace language manifest, user guide and screenshots.
- Documented third-party dependencies and the LGPL distribution of Hunspell.
- Updated the settings window to use plugin-local events.

## 1.4.0

- Introduced the TilType name and light, dark and Marketplace icons.
- Added a Marketplace description in English, Kazakh and Russian.

## 1.3.3

- Added Escape to skip the current word's autocorrection or revert the latest
  correction at the caret.

## 1.3.0

- Added mixed-language spell-check tagging and optional punctuation fixes in the
  context menu.

## 1.2.0

- Integrated offline Hunspell dictionaries and added keyboard navigation.
- Improved correction of consecutive words typed in the wrong keyboard layout.
