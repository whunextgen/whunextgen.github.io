import React from "react";
import { EVENTS } from "../constants";

const Events: React.FC = () => {
  return (
    <div className="bg-white min-h-screen pt-24 pb-20">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <header className="mb-20 pt-10">
          <h1 className="text-5xl md:text-6xl font-serif text-brand-dark mb-6">
            Events
          </h1>
          <p className="text-xl text-slate-500 font-light">
            Seminars, workshops, and lab gatherings.
          </p>
        </header>

        <div className="relative border-l border-slate-200 ml-4 md:ml-0 space-y-16 max-w-5xl">
          {EVENTS.map((event, index) => (
            <div
              key={event.id}
              className="relative pl-8 md:pl-12 animate-fade-in-up"
              style={{ animationDelay: `${index * 100}ms` }}
            >
              {/* Timeline dot */}
              <div className="absolute left-[-5px] top-2 w-2.5 h-2.5 bg-brand-red rounded-full ring-4 ring-white"></div>

              <div className="flex flex-col md:flex-row gap-6 md:gap-12">
                <div className="md:w-48 flex-shrink-0">
                  <h3 className="text-2xl font-serif text-brand-dark">
                    {event.date}
                  </h3>
                  <p className="text-sm font-mono text-slate-400 mt-1">
                    {event.time}
                  </p>
                  <p className="text-xs font-bold uppercase tracking-wider text-blue-600 mt-4">
                    {event.location}
                  </p>
                </div>

                <div className="flex-grow pb-12 border-b border-slate-100 last:border-0">
                  <h2 className="text-2xl font-medium text-brand-dark mb-4">
                    {event.title}
                  </h2>
                  <p className="text-slate-600 font-light leading-relaxed max-w-2xl">
                    {event.description}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default Events;
