// Navegação local do curso: lista e aula compartilham o painel Biblioteca.
import { createEl } from './practice.js';
import { courseLessons } from './course-progress.js';
import { mountCourses } from './course-view.js';
import { mountCourseLesson } from './course-lesson.js';

export function mountCourseWorkspace(container, host) {
  const courseMount = createEl('div', { className: 'course-workspace-list' });
  const lessonMount = createEl('div', { className: 'course-workspace-lesson', hidden: true });
  container.append(courseMount, lessonMount);
  let route = null;
  let suspended = false;
  let destroyed = false;
  const courses = mountCourses(courseMount, { ...host, onOpenLesson: openLesson });
  const lesson = mountCourseLesson(lessonMount, {
    ...host,
    onOpenLesson: openLesson,
    onBack: (courseId, lessonId) => openCourse(courseId, lessonId),
  });

  function hasLesson(courseId, lessonId) {
    const saved = host.store.get(courseId);
    return !!saved && (courseLessons(saved.course).some(item => item.id === lessonId)
      || saved.state.removed.some(item => item.id === lessonId));
  }

  async function openLesson(courseId, lessonId) {
    if (destroyed || !hasLesson(courseId, lessonId)) {
      host.notify?.('Esta aula não está mais disponível no curso.', true);
      return false;
    }
    route = { courseId, lessonId };
    suspended = false;
    courseMount.hidden = true;
    lessonMount.hidden = false;
    await lesson.show(courseId, lessonId);
    if (route?.courseId === courseId && route.lessonId === lessonId && !destroyed) {
      lessonMount.querySelector('#lesson-back')?.focus({ preventScroll: true });
    }
    return true;
  }

  function openCourse(courseId, lessonId = null) {
    if (destroyed) return;
    route = null;
    suspended = false;
    lesson.hide();
    lessonMount.hidden = true;
    courseMount.hidden = false;
    courses.openCourse(courseId);
    if (lessonId) {
      const row = [...courseMount.querySelectorAll('[data-lesson-id]')]
        .find(node => node.dataset.lessonId === lessonId);
      row?.focus({ preventScroll: true });
    }
  }

  function visible() { return !container.closest('[hidden]'); }
  function syncVisibility() {
    if (!route || destroyed) return;
    if (!visible() && !suspended) {
      suspended = true;
      lesson.hide();
    } else if (visible() && suspended) {
      suspended = false;
      void lesson.show(route.courseId, route.lessonId);
    }
  }
  // Sair da Biblioteca ou mudar para Exercícios encerra o intervalo de estudo,
  // salva o rascunho e libera blobs. Voltar não muda a aula escolhida.
  const observer = new MutationObserver(syncVisibility);
  for (let node = container; node; node = node.parentElement) {
    observer.observe(node, { attributes: true, attributeFilter: ['hidden'] });
  }

  return {
    openLesson,
    openCourse,
    render() { if (route) lesson.render(); else courses.render(); },
    get activeLesson() { return route ? { ...route } : null; },
    destroy() {
      destroyed = true;
      route = null;
      observer.disconnect();
      lesson.destroy();
      courses.destroy();
      lessonMount.remove();
      courseMount.remove();
    },
  };
}
