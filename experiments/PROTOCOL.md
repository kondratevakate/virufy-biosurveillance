# Experiment protocol (frozen 2026-11-18, before any of E1 to E3 was run)

Model used throughout (as in the paper draft): for site s and interval t, the true cough
count is Poisson with mean E * b * r, where E is the load in person-hours, b the background
cough rate per person-hour and r the outbreak factor (r = 1 without an outbreak, r >= 1 + kappa
during one). The phone detector thins and contaminates this stream: the observed count is

    Y ~ Poisson( E * (s * b * r + phi) )

with s the detector sensitivity and phi its false-alarm rate per listening hour.

## E1. Detections per hour in real public-space audio

- Question: how often does the deployed detector fire in public places where nobody was asked to cough?
- Data: TAU Urban Acoustic Scenes 2019, development set (Zenodo 2589280), archives audio.1 and
  audio.2 as downloaded; all clips in them, no selection. 10-second clips, 10 scene types.
- Detector: the app's model file and rule: one score per 0.975 s window, an event when the
  "Cough" score is at least 0.5 (the app threshold, fixed on 2026-11-16).
- Outcome: events per hour of audio, overall and per scene, with exact Poisson 95% intervals;
  the same at thresholds 0.3 and 0.7 as sensitivity analysis.
- Reading: the recordings contain unlabelled real coughs, so the number is an upper bound on the
  false-alarm rate phi, not phi itself. No listening or relabelling is done.

## E2. Detection delay as a function of load and detector error (simulation)

- Question: for a fixed false-alarm budget, how many days does it take to detect an outbreak of
  size kappa, and how do crowd size E and the detector's false alarms phi change that?
- Parameters taken from data: s = 0.825 (ESC-50, threshold 0.5); phi = the overall E1 rate and
  the highest per-scene E1 rate. Assumed, and labelled as assumed: b in {0.5, 2} coughs per
  person-hour; day-of-week factors (1.0 weekdays, 0.8 weekend); daily load noise lognormal, sd 0.2.
- Grid: E in {50, 200, 1000, 5000} person-hours per day; kappa in {0.1, 0.2, 0.5, 1.0};
  phi in {0, E1 overall, E1 worst scene}.
- Detectors: (a) Poisson CUSUM with load offset, designed for kappa = 0.5, baseline rate estimated
  from an 8-week burn-in; (b) the prototype's median/MAD rule on the rate Y/E (8-day window,
  z > threshold); (c) EARS C2-style rule (7-day mean and sd, 2-day guard).
- Calibration: each detector's threshold is set by simulation so that the in-control average run
  length (ARL0) is 180 days. Then: average detection delay (ADD) in days and the probability of
  detection within 7 and 14 days, 2000 runs per cell, outbreak starting 30 days after burn-in.
- Theory check: CUSUM delay against the first-order approximation ln(ARL0) / I, with
  I = mu1 * ln(mu1 / mu0) - (mu1 - mu0) the per-day Kullback-Leibler information, mu0 = E (s b + phi),
  mu1 = E (s b (1 + kappa) + phi).
- Robustness (assumed, not from data): negative binomial counts with dispersion size 10.
- Hypotheses: H1 CUSUM has the shortest delay at equal ARL0 for every cell; H2 delay falls roughly
  as 1/E; H3 false alarms phi lengthen the delay by the factor predicted by I.
- Not claimed: anything about real outbreaks. All counts are simulated.

## E3. Aviation wastewater against national clinical positivity (real data, exploratory)

- Question: does the US aviation wastewater positivity series move before, with or after the
  national clinical percent-positive series for the same pathogen?
- Data: Zenodo 18432347 (US file), weekly share of positive samples by MMWR week (week ending
  Saturday); CDC "Percent of Tests Positive for Viral Respiratory Pathogens" (data.cdc.gov
  seuz-s2cv), national weekly values. Pairs: SARS-CoV-2 with COVID-19; Influenza A with Influenza
  (primary), Influenza B with Influenza (secondary); RSV with RSV.
- Outcome: Spearman correlation at lags -6 to +6 weeks; the lag with the highest correlation
  (positive = wastewater leads); 95% interval for that lag from a moving-block bootstrap
  (block 4 weeks, 2000 resamples). Weeks with fewer than 3 wastewater samples are dropped.
- Reading: one season, about 40 weeks, aircraft from many origins against US clinical tests.
  A lag here is descriptive; it is not a validated lead time.
