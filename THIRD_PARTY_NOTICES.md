# Third-party notices

Components in this repository that come from other projects, with their licences.

| Component | Where | Licence |
|---|---|---|
| MediaPipe Tasks Audio 0.10.21 (Google) | `app/vendor/tasks-audio/` | Apache-2.0 |
| Space Grotesk, Space Mono (font files) | `app/fonts/` | SIL Open Font License 1.1 |
| Natural Earth 1:110m country outlines | `app/data/world.json`, `app/data/europe.json`, `app/data/uae.json` | Public domain |
| Virufy logo and icon | `app/img/` | Trademark of The Covid Detection Foundation; not licensed for reuse |

Not included in the repository, fetched or read separately:

| Item | Use | Licence or terms |
|---|---|---|
| YAMNet audio classifier (Google, MediaPipe model) | cough detector; see `app/models/SOURCE.md` | as stated on its model card |
| ESC-50 (K. Piczak) | detector evaluation only; per-clip scores in `eval/results/` are derived from it | CC BY-NC 3.0 |
| TAU Urban Acoustic Scenes 2019 | experiment E1 only | non-commercial, see the Zenodo record |
| Aviation wastewater qPCR dataset, Zenodo doi:10.5281/zenodo.18432347 | derived weekly series in `app/data/wastewater.json` | CC BY 4.0 |
| CDC public data (percent positive, ILINet) | values quoted in the catalog | US federal public data |

Each record of the catalog links to its own source; where a source states a licence, the record
carries it, and a `null` licence means it was not checked.
