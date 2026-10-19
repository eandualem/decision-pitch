import asyncio

from decision_pitch import managers, telemetry
from decision_pitch.arena.models import Answer
from decision_pitch.match import Match
from decision_pitch.players import Players


class Candidate:
    name = "candidate"

    def __init__(self, image=None, fail=False):
        self.image, self.fail, self.questions = image, fail, []

    async def decide(self, question):
        self.questions.append(question)
        if self.fail:
            raise RuntimeError("unavailable")
        return Answer("hold", {})


def test_all_candidates_get_real_state_and_image_probes_without_playing():
    m = Match()
    squad = Players(m)
    text, image, failed = Candidate(), Candidate("message"), Candidate(fail=True)
    samples = telemetry.Samples()
    before = m.snapshot()
    asyncio.run(samples.measure(m, squad, 0, {"jev": text, "openai-image": image, "clef": failed}))
    assert m.snapshot() == before and not squad.seats
    assert text.questions[0].image is None
    assert image.questions[0].image.startswith("data:image/jpeg;base64,")
    assert text.questions[0].state in image.questions[0].state
    assert "1 valid, 0 failed" in samples.describe("jev", m.t)
    assert "0 valid, 1 failed" in samples.describe("clef", m.t)
    assert "football quality unmeasured" in samples.describe("jev", m.t)
    assert "latest 5.0s ago" in samples.describe("jev", m.t + 5)


def test_probes_obey_pause_and_full_time():
    async def go():
        m = Match()
        m.paused = True
        model = Candidate()
        samples = telemetry.Samples()
        task = asyncio.create_task(samples.measure(m, Players(m), 0, {"jev": model}))
        await asyncio.sleep(.02)
        assert not model.questions
        m.paused = False
        await task
        assert len(model.questions) == 1
        m.phase = "full_time"
        await samples.measure(m, Players(m), 0, {"jev": model})
        assert len(model.questions) == 1
    asyncio.run(go())


def test_model_totals_include_former_players_but_never_opponent_data():
    m = Match()
    model = Candidate()
    squad = Players(m, {7: model, 8: model, 12: model})
    staff = managers.Staff(m, squad, (managers.BuiltIn(), managers.BuiltIn()),
                          ({"jev": model, "openai-image": Candidate("message")}, {"jev": model}))
    squad.seats[7].answers = 10
    squad.seats[7].times.extend([.2, .4])
    squad.seats[7].late.update({"no ball": 2})
    squad.seats[8].failures = 3
    squad.seats[12].answers = 999
    staff.performance.players[7].update({"touches": 5, "possession": 4})
    staff.performance.players[12]["touches"] = 999
    m.players.remove(m.player(7))
    feed = staff.feed(0)
    assert "1 currently on pitch, 2 players observed" in feed
    assert "10 answers, 3 failures" in feed
    assert "median 0.300s" in feed
    assert "2 ball actions returned after possession was lost" in feed
    assert "5 touches" in feed
    # Aggregate opponent totals are allowed; the model catalog must contain no opponent internals.
    catalog = '\n'.join(staff.catalog(0))
    assert "999" not in catalog
    assert "openai-image:" in catalog and "input text + labelled pitch image" in catalog
    assert "match: not yet fielded" in catalog


def test_lineup_and_later_consultations_get_refreshed_candidate_measurements():
    class Manager(managers.LanguageModel):
        def __init__(self):
            self.feeds = []

        async def lineup(self, situation):
            self.feeds.append(situation.feed)
            return managers.Lineup({p.id: "jev" for p in situation.match.players if p.team == situation.team})

        async def advise(self, situation):
            self.feeds.append(situation.feed)
            return managers.Advice()

    manager, candidate = Manager(), Candidate()
    m = Match()
    staff = managers.Staff(m, Players(m), (manager, managers.BuiltIn()), ({"jev": candidate}, {"bot": None}))

    async def go():
        await staff.line_up()
        m.t = 31
        await staff.consult(0)
    asyncio.run(go())
    assert "1 valid, 0 failed" in manager.feeds[0]
    assert "2 valid, 0 failed" in manager.feeds[1]
    assert "latest 0.0s ago" in manager.feeds[1]


def test_pending_substitute_is_not_match_evidence_until_it_enters():
    m = Match()
    m.phase = 'play'
    model = Candidate()
    squad = Players(m)
    staff = managers.Staff(m, squad, (managers.BuiltIn(), managers.BuiltIn()), ({'jev': model}, {'jev': model}))
    staff.apply(0, managers.Advice(substitutions=[(7, 26, 'jev')]))
    assert 'not yet fielded' in telemetry.model_performance(staff, 0, 'jev')
    m.phase = 'free_kick'
    m._substitute()
    assert '1 currently on pitch, 1 players observed' in telemetry.model_performance(staff, 0, 'jev')


def test_paused_local_queue_does_not_start_probe_deadline(monkeypatch):
    from decision_pitch.players import OneAtATime
    real_timeout = asyncio.timeout
    deadlines = []

    def short_timeout(seconds):
        deadlines.append(seconds)
        return real_timeout(.03)

    monkeypatch.setattr(telemetry.asyncio, 'timeout', short_timeout)

    async def go():
        m = Match()
        candidate = Candidate()
        local = OneAtATime(candidate)
        samples = telemetry.Samples()
        await local._turn.acquire()
        task = asyncio.create_task(samples.measure(m, Players(m), 0, {'laya': local}))
        await asyncio.sleep(.01)
        m.paused = True
        local._turn.release()
        await asyncio.sleep(.08)  # longer than the test's request deadline
        assert not deadlines and not candidate.questions and not samples.results
        m.paused = False
        await task
        assert deadlines == [6]
        assert samples.results['laya']['failed'] == 0
        assert samples.results['laya']['ok'] == 1
        assert samples.results['laya']['times'][0] < .03
    asyncio.run(go())
