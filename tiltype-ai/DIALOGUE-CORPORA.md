# Additional corpora for TilType AI Phrases

Candidate packages use the corpora below for additional training or
to extract evidence for multiword suggestions.
The importer splits turns into sentences, filters formatting and contact
details, removes duplicates, and excludes normalized sentences found in
the existing held-out test partitions. The package includes quantized
model weights. The corpus archives, transcripts, and audio stay outside
the package.

- **English** — Taskmaster 1–4, Google LLC. The authors include Bill
  Byrne, Karthik Krishnamoorthi, Chinnadhurai Sankar, Saravanan Ganesh,
  Arvind Neelakantan, Amit Dubey, Kyu-Young Kim and Andy Cedilnik.
  Each release is under the [Creative Commons Attribution 4.0
  International License](https://creativecommons.org/licenses/by/4.0/).
  [Taskmaster release](https://github.com/google-research-datasets/Taskmaster/tree/d92cb6af3005f1dc09c39e75e7daf4a04905e00b).
- **Russian and English** — OpenAssistant Conversations, LAION and
  contributors. We use the reviewed, non-synthetic messages. Licensed
  under the [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0).
  [OpenAssistant release](https://huggingface.co/datasets/OpenAssistant/oasst1/tree/fdf72ae0827c1cda404aff25b6603abec9e3399b).
- **Russian** — Matreshka by zjkarina, synthetic dialogues from the
  training split. Licensed under the [Creative Commons Attribution 4.0
  International License](https://creativecommons.org/licenses/by/4.0/).
  [Matreshka release](https://huggingface.co/datasets/zjkarina/matreshka/tree/13ca8409e2750e77fc249c0fa07a79d85089834b).
- **Kazakh** — Our product uses ISSAI Kazakh Speech Corpus 2
  (https://doi.org/10.48342/m90y-aj02), which is available under a Creative
  Commons Attribution 4.0 International License. Saida Mussakhojayeva,
  Yerbolat Khassanov and Huseyin Atakan Varol, Interspeech 2022.
  Text is read from the [Parquet mirror](https://huggingface.co/datasets/diaslmb/KSC2/tree/916e65e49f4659c144c618c479fb9f035ea82b89).

## Profiles for document suggestions

The language profiles store counts of endings after a preceding word. The
document-type profiles also store term weights and counts of short
continuations. Both use separate training documents from the following cached
sources.

- **Russian, Kazakh and English** — Wikipedia contributors, 2023-11-01
  dumps. The dataset card lists CC BY-SA 3.0 and GFDL.
  [Wikimedia dataset release](https://huggingface.co/datasets/wikimedia/wikipedia/tree/b04c8d1ceb2f5cd4588862100d08de323dccfbaa).
- **Russian and Kazakh** — Kazakhstan Legal Corpus by kurumikz, listed under
  ODC Attribution. [Parallel corpus release](https://huggingface.co/datasets/kurumikz/kazakhstan_legal_corpus/tree/0af10cc914303272ce482c32a8e04673269c77a5).
- **English** — EUR-Lex subset of LexGLUE by the CoAStaL NLP Group, listed
  under CC BY 4.0. [LexGLUE release](https://huggingface.co/datasets/coastalcph/lex_glue/tree/c23fdff1a6bf74e0e1a71cb86f1e781d37da888c).
- **Conversation and transcripts** — The sampled Taskmaster, Matreshka and
  KSC2 releases listed above. For these profiles the source documents retain
  their original turn order and are split by document before training.
