// Quiz module: tải câu hỏi từ questions.json và hiển thị popup trắc nghiệm.
// Giao tiếp với game.js qua hai callback: onCorrect() và (ngầm) việc pause/resume do game.js quyết định.

const Quiz = (() => {
  let questions = [];
  let usedIndexes = new Set();
  let currentQuestion = null;
  let onCorrectCallback = null;

  const screenEl = document.getElementById("quiz-screen");
  const questionEl = document.getElementById("quiz-question");
  const optionsEl = document.getElementById("quiz-options");
  const feedbackEl = document.getElementById("quiz-feedback");
  const resultOverlayEl = document.getElementById("quiz-result-overlay");
  const resultImgEl = document.getElementById("quiz-result-img");

  const CORRECT_IMG = "assets/Faker.jpg";
  const WRONG_IMGS = ["assets/wrong_1.jpg", "assets/wrong_2.png", "assets/wrong_3.png", "assets/wrong_4.png"];

  function showResultImg(src) {
    resultImgEl.src = src;
    resultOverlayEl.classList.remove("hidden");
  }

  function hideResultImg() {
    resultOverlayEl.classList.add("hidden");
    resultImgEl.src = "";
  }

  async function loadQuestions() {
    try {
      const res = await fetch("questions.json");
      questions = await res.json();
    } catch (err) {
      console.error("Không tải được questions.json:", err);
      questions = [];
    }
  }

  function pickQuestion() {
    if (questions.length === 0) return null;
    // Reset vòng lặp nếu đã hỏi hết
    if (usedIndexes.size >= questions.length) {
      usedIndexes.clear();
    }
    let idx;
    do {
      idx = Math.floor(Math.random() * questions.length);
    } while (usedIndexes.has(idx) && usedIndexes.size < questions.length);
    usedIndexes.add(idx);
    return questions[idx];
  }

  function renderQuestion(q) {
    questionEl.textContent = q.question;
    feedbackEl.textContent = "";
    optionsEl.innerHTML = "";
    hideResultImg(); // câu hỏi mới (kể cả sau khi trả lời sai) -> ẩn ảnh của lượt trước đi

    q.options.forEach((opt, i) => {
      const btn = document.createElement("button");
      btn.className = "quiz-option-btn";
      btn.textContent = opt;
      btn.addEventListener("click", () => handleAnswer(i, btn));
      optionsEl.appendChild(btn);
    });
  }

  function handleAnswer(selectedIndex, btnEl) {
    const isCorrect = selectedIndex === currentQuestion.answerIndex;
    const allBtns = optionsEl.querySelectorAll("button");
    allBtns.forEach((b) => (b.disabled = true));

    if (isCorrect) {
      btnEl.classList.add("correct");
      feedbackEl.textContent = "Chuẩn không cần chỉnh!";
      feedbackEl.style.color = "#2ecc71";
      Audio_.playCorrectAnswer();
      showResultImg(CORRECT_IMG);
      setTimeout(() => {
        hide();
        if (onCorrectCallback) onCorrectCallback();
      }, 700);
    } else {
      btnEl.classList.add("wrong");
      Audio_.playWrongAnswer();
      const randomWrongImg = WRONG_IMGS[Math.floor(Math.random() * WRONG_IMGS.length)];
      showResultImg(randomWrongImg);
      startWrongCountdown();
    }
  }

  const WRONG_COUNTDOWN_SEC = 2;

  function startWrongCountdown() {
    let remaining = WRONG_COUNTDOWN_SEC;
    feedbackEl.style.color = "#e74c3c";
    feedbackEl.textContent = `Ối dồi ôi! Câu tiếp theo sau ${remaining}s...`;

    const tick = () => {
      remaining--;
      if (remaining > 0) {
        feedbackEl.textContent = `Ối dồi ôi! Câu tiếp theo sau ${remaining}s...`;
        setTimeout(tick, 1000);
      } else {
        currentQuestion = pickQuestion();
        if (currentQuestion) renderQuestion(currentQuestion);
      }
    };
    setTimeout(tick, 1000);
  }

  function show(onCorrect) {
    onCorrectCallback = onCorrect;
    currentQuestion = pickQuestion();
    if (!currentQuestion) {
      // Không có câu hỏi nào (file rỗng) -> cho qua luôn để không kẹt game
      if (onCorrectCallback) onCorrectCallback();
      return;
    }
    renderQuestion(currentQuestion);
    screenEl.classList.remove("hidden");
  }

  function hide() {
    screenEl.classList.add("hidden");
    hideResultImg();
  }

  return { loadQuestions, show, hide };
})();
