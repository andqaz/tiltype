# Model sources

The included weights were trained for next-word prediction on selected
sentences from the Leipzig Corpora Collection, Tatoeba, and KazNERD.
Source archives and licenses are credited in DICTIONARY-NOTICE.md.
The training scripts deduplicate sentences and exclude the TilType
held-out partition. The package ships trained weights and output
vocabulary. Inference requires no network access.
