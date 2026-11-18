"""Unit tests for the experiment helpers (no audio, no network)."""
import datetime as dt
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "experiments"))
import e2_detection_delay as e2  # noqa: E402
from e3_wastewater_vs_clinical import mmwr_week_end  # noqa: E402


def test_mmwr_week_ends_on_saturday():
    assert mmwr_week_end(dt.date(2024, 3, 28)) == dt.date(2024, 3, 30)   # Thursday
    assert mmwr_week_end(dt.date(2024, 3, 30)) == dt.date(2024, 3, 30)   # Saturday itself
    assert mmwr_week_end(dt.date(2024, 3, 31)) == dt.date(2024, 4, 6)    # Sunday starts a new week


def test_first_alarm_returns_length_when_no_alarm():
    stat = np.array([[0.0, 1.0, 5.0], [0.0, 0.0, 0.0]])
    assert e2.first_alarm(stat, 2.0).tolist() == [2, 3]


def test_calibration_hits_the_target_run_length():
    rng = np.random.default_rng(1)
    load, y = e2.simulate(rng, 400, 1500, E=200, b=0.5, phi=0.0)
    stat = e2.stat_cusum(load, y)
    h = e2.calibrate(stat)
    arl = (e2.first_alarm(stat, h) + 1).mean()
    assert arl == pytest.approx(e2.ARL0, rel=0.05)


def test_outbreak_raises_counts_only_after_its_start():
    rng = np.random.default_rng(2)
    _, y = e2.simulate(rng, 2000, 60, E=1000, b=0.5, phi=0.0, kappa=1.0, start=30)
    before, after = y[:, e2.BURN:e2.BURN + 30].mean(), y[:, e2.BURN + 30:].mean()
    assert after / before == pytest.approx(2.0, rel=0.05)


def test_false_alarms_reduce_the_information_per_day():
    clean, noisy = e2.kl_info(200, 0.5, 0.0, 0.5), e2.kl_info(200, 0.5, 1.0, 0.5)
    assert noisy < clean
