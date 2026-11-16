# Model provenance

`yamnet.tflite` is not committed. Fetch it once into this folder:

    curl -L -o app/models/yamnet.tflite https://storage.googleapis.com/mediapipe-models/audio_classifier/yamnet/float32/1/yamnet.tflite

- Model: YAMNet audio classifier, float32, version 1, as published by Google MediaPipe for the Audio Classifier task.
- Retrieved: 2026-11-16.
- SHA-256: `4d8b4a53282dc83ef04e3e7dbc4fbc98082e34e44ed798e16c3a0cdd4c584faf`
- Output: 521 AudioSet classes; the app reads class "Cough" (index 42 in the YAMNet class map).

The same file is used by the browser app and by `eval/eval_esc50.py`, so the evaluation numbers describe the deployed detector.
