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
      setTimeout(() => {
        hide();
        if (onCorrectCallback) onCorrectCallback();
      }, 700);
    } else {
      btnEl.classList.add("wrong");
      feedbackEl.textContent = "Ối dồi ôi!";
      feedbackEl.style.color = "#e74c3c";
      setTimeout(() => {
        currentQuestion = pickQuestion();
        if (currentQuestion) renderQuestion(currentQuestion);
      }, 900);
    }
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
  }

  return { loadQuestions, show, hide };
})();
